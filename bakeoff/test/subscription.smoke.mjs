/**
 * Smoke suite for src/subscription/ — the two subscription adapters.
 *
 *   npm run build && node test/subscription.smoke.mjs
 *
 * NO CREDENTIALS ARE REQUIRED AND NONE ARE USED. Every case runs against an
 * ISOLATED, EMPTY credential directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`
 * under a temp dir), so the owner's real logins are never read, never touched,
 * and no quota is consumed. Nothing here makes a model call.
 *
 * The claim under test is the one the module exists to make good on:
 *
 *   A NOT-LOGGED-IN PROVIDER PRODUCES A CLEAN STRUCTURED `authStatus`,
 *   NOT A STACK TRACE — from `authStatus()` AND from `run()`.
 *
 * Section 3 is that claim for both adapters. Section 4 is its negative control
 * and the most important assertion in the file: an `ANTHROPIC_API_KEY` in the
 * environment makes the Claude CLI report `loggedIn: true` on a machine with no
 * subscription at all, and every token spent that way is BILLED. The test
 * asserts the raw CLI behaviour first, then asserts the adapter is NOT fooled
 * by it. Without that, "logged in" would silently mean "spending money" behind
 * a dashboard that shows no cost — because a subscription run has none to show.
 *
 * Two layers, and they prove different things:
 *   LAYER 1 (sections 1-9, always runs) — offline, no SDK installed, no
 *     credentials. Proves the STRUCTURE of every failure path.
 *   LAYER 2 (section 10, opt-in via BAKEOFF_SUBSCRIPTION_LIVE=1) — drives the
 *     real SDK against an empty CODEX_HOME and asserts the live 401 maps to
 *     `authStatus` missing. Needs network and the SDK installed; SKIPPED BY
 *     DEFAULT. Layer 1 passing is NOT evidence that the live 401 mapping works.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

if (!existsSync(join(DIST, "subscription", "index.js"))) {
  console.error(`no build at ${DIST}/subscription. Run: npm run build`);
  process.exit(2);
}

const S = await import(`${DIST}/subscription/index.js`);

let pass = 0;
const failures = [];
const notes = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const scratch = mkdtempSync(join(tmpdir(), "bakeoff-subs-"));
const emptyClaudeHome = join(scratch, "claude-config");
const emptyCodexHome = join(scratch, "codex-home");
const gitWorkspace = join(scratch, "workspace-git");
const plainWorkspace = join(scratch, "workspace-plain");
for (const dir of [emptyClaudeHome, emptyCodexHome, gitWorkspace, plainWorkspace]) {
  mkdirSync(dir, { recursive: true });
}
// `.git` only has to EXIST for the adapter's guard; no git binary is needed.
mkdirSync(join(gitWorkspace, ".git"), { recursive: true });

/** A base env that cannot reach any real credential store. */
function isolatedEnv(extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: emptyClaudeHome, CODEX_HOME: emptyCodexHome };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return { ...env, ...extra };
}

function runOptions(workspaceDir) {
  return {
    workspaceDir,
    model: null,
    effort: null,
    maxTurns: null,
    systemPromptAppend: null,
    autonomy: "workspace-write",
    envOverrides: null,
  };
}

/** Drain an adapter run. Fails loudly if it throws — it is written never to. */
async function collect(name, iterable) {
  const events = [];
  try {
    for await (const event of iterable) events.push(event);
  } catch (error) {
    failures.push(`${name} — run() THREW instead of yielding a failed event: ${String(error?.message).slice(0, 200)}`);
  }
  return events;
}

function terminalOf(events) {
  const last = events[events.length - 1];
  return last === undefined ? null : last;
}

/** A message is operator-facing prose, not a dumped stack. */
function looksLikeAStackTrace(text) {
  return /\n\s+at\s+\S+\s*\(|node:internal\/|\.js:\d+:\d+\)/.test(String(text));
}

const cliOnPath = (bin) => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
};
const HAS_CLAUDE = cliOnPath("claude");
const HAS_CODEX = cliOnPath("codex");

// ------------------------------------------------- 1. the unpriced invariant
{
  const usage = S.emptyUsage();
  ok(
    "emptyUsage reports nulls, never zeroes (an unreported count is not 0)",
    usage.inputTokens === null && usage.outputTokens === null && usage.cacheWriteTokens === null,
    JSON.stringify(usage),
  );
  ok("SubscriptionUsage carries no cost field", S.assertUnpriced(usage).length === 0);
  ok(
    "assertUnpriced CATCHES a cost field (a guard that cannot fire is not a guard)",
    S.assertUnpriced({ usage: { total_cost_usd: 1.23 } }).length === 1,
    JSON.stringify(S.assertUnpriced({ usage: { total_cost_usd: 1.23 } })),
  );
  ok(
    "assertUnpriced looks inside arrays",
    S.assertUnpriced([{ ok: 1 }, { priceUsd: 2 }]).length === 1,
  );
}

// ------------------------------------------------------- 2. rate-limit logic
{
  const nowMs = Date.parse("2026-07-27T12:00:00.000Z");
  const inOneHourSec = Math.floor(nowMs / 1000) + 3600;

  ok(
    "resetsAt in epoch SECONDS decodes",
    S.resetsAtToIso(inOneHourSec, nowMs) === "2026-07-27T13:00:00.000Z",
    String(S.resetsAtToIso(inOneHourSec, nowMs)),
  );
  ok(
    "resetsAt in epoch MILLISECONDS decodes to the same instant",
    S.resetsAtToIso(inOneHourSec * 1000, nowMs) === "2026-07-27T13:00:00.000Z",
  );
  ok("an implausible resetsAt is null, not a countdown to 1970", S.resetsAtToIso(42, nowMs) === null);

  ok("utilization 0.42 stays a fraction", S.normalizeUtilization(0.42) === 0.42);
  ok("utilization 42 is read as a percentage", S.normalizeUtilization(42) === 0.42);
  ok("utilization 4200 is not interpreted at all", S.normalizeUtilization(4200) === null);

  const rejected = S.anthropicRateLimitState(
    { status: "rejected", resetsAt: inOneHourSec, rateLimitType: "five_hour", utilization: 1, errorCode: null },
    nowMs,
  );
  ok("a rejected five-hour window is limited", rejected.limited === true);
  ok("...and names the window", rejected.kind === "five_hour", rejected.kind);
  ok("...and carries the reset instant", rejected.resetsAtIso === "2026-07-27T13:00:00.000Z");
  ok("...and a retry-after derived from it", rejected.retryAfterSeconds === 3600, String(rejected.retryAfterSeconds));
  ok("...sourced as the structured event", rejected.source === "rate_limit_event");

  const warning = S.anthropicRateLimitState(
    { status: "allowed_warning", resetsAt: null, rateLimitType: "seven_day", utilization: 0.8, errorCode: null },
    nowMs,
  );
  ok("a WARNING is not a rejection", warning.limited === false);
  ok("...but still reports utilization, so the window can be shown filling", warning.utilization === 0.8);
  ok("seven_day maps to the weekly cap", warning.kind === "weekly", warning.kind);
  ok(
    "seven_day_opus is kept distinct from the whole-account weekly cap",
    S.anthropicLimitKind("seven_day_opus") === "weekly_model",
  );

  // The Codex path: text only, and no invented wait.
  const codexLimit = S.rateLimitFromText("You've hit your usage limit for this 5-hour window.");
  ok("a quota message in free text is detected", codexLimit !== null && codexLimit.limited === true);
  ok("...classified from the wording", codexLimit?.kind === "five_hour", String(codexLimit?.kind));
  ok("...labelled as the WEAKEST signal", codexLimit?.source === "message_text");
  ok(
    "...WITH NO FABRICATED RETRY-AFTER when the provider did not state one",
    codexLimit?.retryAfterSeconds === null && codexLimit?.resetsAtIso === null,
    JSON.stringify(codexLimit),
  );

  const stated = S.rateLimitFromText("Rate limited. Try again in 15 minutes.");
  ok("...but a STATED wait is used", stated?.retryAfterSeconds === 900, String(stated?.retryAfterSeconds));
  ok("retry-after headers parse", S.retryAfterFromText("retry-after: 30") === 30);
  ok("retry-after in hours parses", S.retryAfterFromText("Retry-After: 2 hours") === 7200);
  ok("no wait stated means null", S.retryAfterFromText("something went wrong") === null);

  ok(
    "A 401 IS NOT A RATE LIMIT (different state, different remediation)",
    S.rateLimitFromText("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header") === null,
  );

  const merged = S.mergeRateLimitState(codexLimit, rejected);
  ok("a structured signal outranks a text match", merged.source === "rate_limit_event");
  const backwards = S.mergeRateLimitState(rejected, S.notRateLimited());
  ok("a later 'not limited' does not reopen a closed window", backwards.limited === true);
  ok(
    "describeRateLimit says so when the reset time is unknown",
    S.describeRateLimit(codexLimit).includes("did not report when it reopens"),
    S.describeRateLimit(codexLimit),
  );

  ok(
    "vendor prefix tables are matched, not re-implemented",
    S.matchesVendorPrefix("You've hit your usage limit", ["You've hit your"]) === true &&
      S.matchesVendorPrefix("all good", ["You've hit your"]) === false,
  );
}

// -------------------------------- 3. THE CLAIM: not logged in is structured
{
  const claude = new S.ClaudeAgentAdapter({ env: isolatedEnv() });
  const codex = new S.CodexAdapter({ env: isolatedEnv() });

  if (HAS_CLAUDE) {
    const status = await claude.authStatus();
    ok("claude authStatus() resolves (never rejects)", status !== null && status !== undefined);
    ok("claude: not logged in reports state 'missing'", status.state === "missing", JSON.stringify(status));
    ok("claude: the probe is the STRUCTURED one", status.probe === "cli_json", status.probe);
    ok(
      "claude: remediation names the exact command",
      status.remediation.includes("claude setup-token"),
      status.remediation,
    );
    ok(
      "claude: remediation warns AGAINST setting an API key",
      status.remediation.includes("ANTHROPIC_API_KEY"),
    );
    ok("claude: no stack trace in the detail", !looksLikeAStackTrace(status.detail), status.detail);
    ok(
      "claude: NO PERSONAL DATA is carried (no email / orgId / orgName keys)",
      !Object.keys(status).some((k) => /email|org|account|user/i.test(k)),
      Object.keys(status).join(","),
    );
    ok("claude: the status object carries no cost field", S.assertUnpriced(status).length === 0);
  } else {
    notes.push("claude CLI not on PATH — its authStatus assertions were skipped");
  }

  if (HAS_CODEX) {
    const status = await codex.authStatus();
    ok("codex authStatus() resolves (never rejects)", status !== null && status !== undefined);
    ok("codex: not logged in reports state 'missing'", status.state === "missing", JSON.stringify(status));
    ok(
      "codex: the probe records that it read PROSE, not JSON",
      status.probe === "cli_text",
      status.probe,
    );
    ok("codex: remediation names the exact command", status.remediation.includes("codex login"), status.remediation);
    ok(
      "codex: remediation warns AGAINST --with-api-key",
      status.remediation.includes("with-api-key"),
      status.remediation,
    );
    ok("codex: no stack trace in the detail", !looksLikeAStackTrace(status.detail), status.detail);
  } else {
    notes.push("codex CLI not on PATH — its authStatus assertions were skipped");
  }

  // ...and the same claim through run(), which is the path the dashboard uses.
  if (HAS_CLAUDE) {
    const events = await collect("claude run()", claude.run("say hi", runOptions(gitWorkspace)));
    const terminal = terminalOf(events);
    ok("claude run(): a terminal event is always emitted", terminal !== null);
    ok("claude run(): it is a FAILED event, not a throw", terminal?.type === "failed", terminal?.type);
    ok("claude run(): the failure kind is 'auth'", terminal?.failure?.kind === "auth", terminal?.failure?.kind);
    ok(
      "claude run(): the failure CARRIES the structured authStatus",
      terminal?.failure?.authStatus?.state === "missing",
      JSON.stringify(terminal?.failure?.authStatus),
    );
    ok(
      "claude run(): the message is prose, not a stack trace",
      !looksLikeAStackTrace(terminal?.failure?.message),
      String(terminal?.failure?.message).slice(0, 160),
    );
    ok(
      "claude run(): an `auth` event precedes the failure so a UI can react early",
      events.some((e) => e.type === "auth"),
    );
    ok(
      "claude run(): NOT ONE emitted event carries a cost field",
      events.every((e) => S.assertUnpriced(e).length === 0),
    );
    ok(
      "claude run(): every event carries a timestamp",
      events.every((e) => typeof e.at === "string" && e.at.length > 0),
    );
  }

  if (HAS_CODEX) {
    const events = await collect("codex run()", codex.run("say hi", runOptions(gitWorkspace)));
    const terminal = terminalOf(events);
    ok("codex run(): it is a FAILED event, not a throw", terminal?.type === "failed", terminal?.type);
    ok("codex run(): the failure kind is 'auth'", terminal?.failure?.kind === "auth", terminal?.failure?.kind);
    ok(
      "codex run(): the failure CARRIES the structured authStatus",
      terminal?.failure?.authStatus?.state === "missing",
    );
    ok(
      "codex run(): the message is prose, not a stack trace",
      !looksLikeAStackTrace(terminal?.failure?.message),
      String(terminal?.failure?.message).slice(0, 160),
    );
    ok(
      "codex run(): NOT ONE emitted event carries a cost field",
      events.every((e) => S.assertUnpriced(e).length === 0),
    );
  }
}

// ------- 4. NEGATIVE CONTROL: an API key must not masquerade as the plan
{
  if (HAS_CLAUDE) {
    // First, the raw CLI behaviour this defends against. If this assertion ever
    // fails, the vendor changed something and the strip may no longer be needed
    // — but finding that out from a failing test beats finding it out from a bill.
    let raw = null;
    try {
      const out = execFileSync("claude", ["auth", "status", "--json"], {
        env: {
          ...isolatedEnv(),
          ANTHROPIC_API_KEY: `not-a-real-key-${"0".repeat(20)}`,
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      raw = JSON.parse(out);
    } catch {
      raw = null;
    }
    ok(
      "MEASURED: a bare ANTHROPIC_API_KEY makes the CLI claim loggedIn on an empty config",
      raw?.loggedIn === true && raw?.authMethod === "api_key",
      JSON.stringify(raw),
    );

    // Now the adapter, given the same environment.
    const adapter = new S.ClaudeAgentAdapter({
      env: isolatedEnv({ ANTHROPIC_API_KEY: `not-a-real-key-${"0".repeat(20)}` }),
    });
    const status = await adapter.authStatus();
    ok(
      "THE ADAPTER IS NOT FOOLED: it strips ANTHROPIC_API_KEY and still reports 'missing'",
      status.state === "missing",
      JSON.stringify(status),
    );
    ok(
      "...so a billed key can never present as a subscription login",
      status.state !== "authenticated",
    );
    ok(
      "ANTHROPIC_API_KEY is on the documented strip list",
      S.ANTHROPIC_BILLED_ENV_NAMES.includes("ANTHROPIC_API_KEY"),
    );
    ok(
      "ANTHROPIC_AUTH_TOKEN is NOT stripped — it is a subscription OAuth login",
      !S.ANTHROPIC_BILLED_ENV_NAMES.includes("ANTHROPIC_AUTH_TOKEN"),
    );
  }
  ok(
    "CODEX_API_KEY — the SDK's own billing lever — is stripped",
    S.CODEX_BILLED_ENV_NAMES.includes("CODEX_API_KEY"),
  );
}

// ------------------------------ 5. the no-SDK path, deterministic and offline
{
  const authenticated = (provider) => async () => ({
    provider,
    state: "authenticated",
    method: "test",
    subscriptionTier: null,
    probe: "cli_json",
    detail: "test stub",
    remediation: "",
  });
  const brokenLoader = async (specifier) => {
    throw new Error(`Cannot find package '${specifier}'`);
  };

  for (const [name, adapter] of [
    ["claude", new S.ClaudeAgentAdapter({ env: isolatedEnv(), authProbe: authenticated("anthropic"), loadModule: brokenLoader })],
    ["codex", new S.CodexAdapter({ env: isolatedEnv(), authProbe: authenticated("openai"), loadModule: brokenLoader })],
  ]) {
    const events = await collect(`${name} no-SDK`, adapter.run("hi", runOptions(gitWorkspace)));
    const terminal = terminalOf(events);
    ok(`${name}: a missing SDK is reported, not thrown`, terminal?.type === "failed", terminal?.type);
    ok(
      `${name}: the kind is 'sdk_unavailable'`,
      terminal?.failure?.kind === "sdk_unavailable",
      terminal?.failure?.kind,
    );
    ok(
      `${name}: the remediation is the install command`,
      String(terminal?.failure?.remediation).includes("npm install"),
      terminal?.failure?.remediation,
    );
    ok(
      `${name}: no stack trace reaches the caller`,
      !looksLikeAStackTrace(terminal?.failure?.message),
      String(terminal?.failure?.message).slice(0, 160),
    );
  }
}

// ---- 5b. the full translation path, offline, against a STUB SDK module.
//
// This is where redaction and the unpriced invariant are tested against a
// REALISTIC payload rather than against an empty object. The stub emits the
// message shapes taken from @anthropic-ai/claude-agent-sdk@0.3.220's own type
// definitions — including `total_cost_usd`, which really is on the result
// message and really must never reach the dashboard.
{
  const authenticated = async () => ({
    provider: "anthropic",
    state: "authenticated",
    method: "claude.ai",
    subscriptionTier: "max",
    probe: "cli_json",
    detail: "test stub",
    remediation: "",
  });

  // Assembled at run time: no credential-shaped literal exists in this tree.
  const leaked = ["sk", "ant", "api03"].join("-") + "-" + "AbcdEfgh1234".repeat(2);

  const stubModule = (messages) => async () => ({
    query: () =>
      (async function* () {
        for (const message of messages) yield message;
      })(),
    USAGE_LIMIT_ERROR_PREFIXES: ["You've hit your"],
    USAGE_WARNING_PREFIXES: ["You've used"],
  });

  const happyPath = [
    {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-opus-5",
      claude_code_version: "9.9.9",
      apiKeySource: "oauth",
    },
    {
      type: "assistant",
      session_id: "sess-1",
      message: {
        content: [
          { type: "text", text: `the key is ${leaked} — do not print it` },
          { type: "thinking", thinking: "considering the options" },
          { type: "tool_use", id: "tu-1", name: "Bash" },
        ],
      },
    },
    {
      type: "rate_limit_event",
      session_id: "sess-1",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      is_error: false,
      num_turns: 3,
      duration_ms: 1234,
      result: "all done",
      total_cost_usd: 4.56,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
    },
  ];

  const adapter = new S.ClaudeAgentAdapter({
    env: isolatedEnv(),
    authProbe: authenticated,
    loadModule: stubModule(happyPath),
  });
  const events = await collect("claude stub", adapter.run("build it", runOptions(gitWorkspace)));
  const serialised = JSON.stringify(events);
  const terminal = terminalOf(events);

  ok("stub: the run completes", terminal?.type === "completed", terminal?.type);
  ok("stub: a session event carries the model", events.some((e) => e.type === "session" && e.model === "claude-opus-5"));
  ok("stub: ...and the client version", events.some((e) => e.type === "session" && e.clientVersion === "9.9.9"));
  ok("stub: assistant prose becomes a message event", events.some((e) => e.type === "message"));
  ok("stub: thinking becomes a reasoning event", events.some((e) => e.type === "reasoning"));
  ok("stub: tool_use becomes a tool event", events.some((e) => e.type === "tool" && e.name === "Bash"));

  ok(
    "REDACTION: the credential-shaped value NEVER appears in any event",
    !serialised.includes(leaked),
    serialised.slice(0, 200),
  );
  ok(
    "REDACTION: ...and the placeholder is there instead, so the reader knows",
    serialised.includes("[REDACTED:"),
  );

  ok(
    "UNPRICED: total_cost_usd is on the SDK's result message and is DROPPED",
    !serialised.includes("4.56") && !serialised.includes("total_cost_usd"),
  );
  ok("UNPRICED: no event carries any cost-shaped key", events.every((e) => S.assertUnpriced(e).length === 0));

  ok("stub: token counts survive intact", terminal?.outcome?.usage?.inputTokens === 100);
  ok("stub: ...including cache writes", terminal?.outcome?.usage?.cacheWriteTokens === 2);
  ok(
    "stub: Anthropic reports no separate reasoning count, so it stays null (not 0)",
    terminal?.outcome?.usage?.reasoningTokens === null,
  );
  ok("stub: turns are reported", terminal?.outcome?.turns === 3);
  ok("stub: the session is marked resumable", terminal?.outcome?.resumable === true);
  ok(
    "stub: a rate-limit WARNING is surfaced without being treated as a rejection",
    events.some((e) => e.type === "rate_limit" && e.state.limited === false && e.state.utilization === 0.9),
  );

  // A usage payload missing a field must produce null and SAY SO, never 0.
  const partial = new S.ClaudeAgentAdapter({
    env: isolatedEnv(),
    authProbe: authenticated,
    loadModule: stubModule([
      { type: "result", subtype: "success", session_id: "s2", is_error: false, result: "ok", usage: { input_tokens: 7 } },
    ]),
  });
  const partialEvents = await collect("claude partial usage", partial.run("x", runOptions(gitWorkspace)));
  const partialUsage = terminalOf(partialEvents)?.outcome?.usage;
  ok("stub: an unreported token count is null, NEVER 0", partialUsage?.outputTokens === null, JSON.stringify(partialUsage));
  ok(
    "stub: ...and the gap is named rather than hidden",
    String(partialUsage?.shapeProblem).includes("output_tokens") &&
      String(partialUsage?.shapeProblem).includes("NOT zero"),
    partialUsage?.shapeProblem,
  );

  // THE BILLING GUARD: a session that is actually spending money must not run.
  const billed = new S.ClaudeAgentAdapter({
    env: isolatedEnv(),
    authProbe: authenticated,
    loadModule: stubModule([
      { type: "system", subtype: "init", session_id: "s3", model: "m", apiKeySource: "user" },
    ]),
  });
  const billedEvents = await collect("claude billed session", billed.run("x", runOptions(gitWorkspace)));
  ok(
    "BILLING GUARD: a session authenticated by API key is refused mid-run",
    terminalOf(billedEvents)?.failure?.kind === "unexpected_billing",
    terminalOf(billedEvents)?.failure?.kind,
  );
  ok(
    "...and the message says the tokens would be billed",
    /BILLED/.test(String(terminalOf(billedEvents)?.failure?.message)),
  );

  // cancel(): a cancelled run must be distinguishable from a finished one.
  const cancellable = new S.ClaudeAgentAdapter({
    env: isolatedEnv(),
    authProbe: authenticated,
    loadModule: stubModule([
      { type: "system", subtype: "init", session_id: "s4", model: "m", apiKeySource: "oauth" },
      { type: "assistant", session_id: "s4", message: { content: [{ type: "text", text: "working" }] } },
    ]),
  });
  const cancelEvents = [];
  for await (const event of cancellable.run("x", runOptions(gitWorkspace))) {
    cancelEvents.push(event);
    if (event.type === "session") cancellable.cancel();
  }
  const cancelTerminal = terminalOf(cancelEvents);
  ok("cancel(): the run ends in a FAILED event, not a silent stop", cancelTerminal?.type === "failed", cancelTerminal?.type);
  ok("cancel(): ...with kind 'cancelled'", cancelTerminal?.failure?.kind === "cancelled", cancelTerminal?.failure?.kind);
  ok("cancel(): ...and is still resumable", cancelTerminal?.failure?.resumable === true);
}

// ---- 5c. the CODEX translation path, offline, against a STUB SDK module.
//
// Shapes taken from @openai/codex-sdk@0.145.0's own type definitions. This
// section exists because section 5b only covered the Anthropic mapping: the
// first version of the Codex adapter shipped `finalText: ""` on every
// successful run, because Codex's `turn.completed` carries ONLY usage and the
// agent's answer arrives earlier as an `agent_message` item. An empty string is
// indistinguishable from "the agent said nothing" — the same trade this module
// refuses for token counts.
{
  const authenticated = async () => ({
    provider: "openai",
    state: "authenticated",
    method: "chatgpt",
    subscriptionTier: null,
    probe: "cli_text",
    detail: "test stub",
    remediation: "",
  });

  const codexEvents = [
    { type: "thread.started", thread_id: "thr-42" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i1", type: "reasoning", text: "thinking about it" } },
    {
      type: "item.completed",
      item: {
        id: "i2",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "3 passing",
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: { id: "i3", type: "file_change", status: "completed", changes: [{ path: "index.html", kind: "add" }] },
    },
    { type: "item.completed", item: { id: "i4", type: "agent_message", text: "Built the page and it passes." } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 900,
        cached_input_tokens: 800,
        cache_write_input_tokens: 64,
        output_tokens: 120,
        reasoning_output_tokens: 55,
      },
    },
  ];

  const stub = async () => ({
    Codex: class {
      startThread() {
        return {
          id: "thr-42",
          async runStreamed() {
            return {
              events: (async function* () {
                for (const event of codexEvents) yield event;
              })(),
            };
          },
        };
      }
      resumeThread() {
        return this.startThread();
      }
    },
  });

  const adapter = new S.CodexAdapter({ env: isolatedEnv(), authProbe: authenticated, loadModule: stub });
  const events = await collect("codex stub", adapter.run("build it", runOptions(gitWorkspace)));
  const terminal = terminalOf(events);

  ok("codex stub: the run completes", terminal?.type === "completed", terminal?.type);
  ok(
    "codex stub: FINAL TEXT IS CARRIED (it arrives as an agent_message item, not on turn.completed)",
    terminal?.outcome?.finalText === "Built the page and it passes.",
    JSON.stringify(terminal?.outcome?.finalText),
  );
  ok("codex stub: the thread id becomes the session id", terminal?.sessionId === "thr-42", terminal?.sessionId);
  ok("codex stub: the run is resumable", terminal?.outcome?.resumable === true);
  ok(
    "codex stub: Codex reports no turn count, so it is null rather than a guess",
    terminal?.outcome?.turns === null,
  );

  const usage = terminal?.outcome?.usage;
  ok("codex stub: input tokens map", usage?.inputTokens === 900, JSON.stringify(usage));
  ok("codex stub: cached_input_tokens -> cacheReadTokens", usage?.cacheReadTokens === 800);
  ok("codex stub: cache_write_input_tokens IS reported by codex and maps", usage?.cacheWriteTokens === 64);
  ok("codex stub: output tokens map", usage?.outputTokens === 120);
  ok("codex stub: reasoning_output_tokens -> reasoningTokens", usage?.reasoningTokens === 55);
  ok("codex stub: a complete payload records no shape problem", usage?.shapeProblem === null, usage?.shapeProblem);

  ok("codex stub: reasoning becomes a reasoning event", events.some((e) => e.type === "reasoning"));
  ok(
    "codex stub: a command becomes a tool event with its output",
    events.some((e) => e.type === "tool" && e.name === "npm test" && e.detail.includes("3 passing")),
  );
  ok(
    "codex stub: a patch becomes a file_change event",
    events.some((e) => e.type === "file_change" && e.paths.includes("index.html") && e.applied === true),
  );
  ok("codex stub: no event carries a cost field", events.every((e) => S.assertUnpriced(e).length === 0));
}

// ------------------------------------- 6. the other expected, non-fatal paths
{
  const authenticated = async () => ({
    provider: "openai",
    state: "authenticated",
    method: "test",
    subscriptionTier: null,
    probe: "cli_json",
    detail: "test stub",
    remediation: "",
  });

  const codex = new S.CodexAdapter({ env: isolatedEnv(), authProbe: authenticated });
  const nonGit = await collect("codex non-git", codex.run("hi", runOptions(plainWorkspace)));
  const nonGitTerminal = terminalOf(nonGit);
  ok(
    "codex: a non-git workspace is named explicitly, not surfaced as a subprocess error",
    nonGitTerminal?.failure?.kind === "not_a_git_repo",
    nonGitTerminal?.failure?.kind,
  );
  ok(
    "...with `git init` as the remediation",
    String(nonGitTerminal?.failure?.remediation).includes("git init"),
    nonGitTerminal?.failure?.remediation,
  );

  const missingDir = await collect(
    "codex missing workspace",
    codex.run("hi", runOptions(join(scratch, "does-not-exist"))),
  );
  ok(
    "a missing workspace is a 'workspace' failure",
    terminalOf(missingDir)?.failure?.kind === "workspace",
    terminalOf(missingDir)?.failure?.kind,
  );

  // resume() with nothing recorded: the post-restart case, which is exactly
  // when resume matters most.
  const fresh = new S.CodexAdapter({ env: isolatedEnv() });
  const resumed = await collect("codex resume", fresh.resume("thread-123"));
  const resumeTerminal = terminalOf(resumed);
  ok("resume() with no options fails cleanly", resumeTerminal?.type === "failed", resumeTerminal?.type);
  ok(
    "...and says the run is still resumable, so nothing is discarded",
    resumeTerminal?.failure?.resumable === true,
  );
  ok(
    "...and names what the caller must persist",
    String(resumeTerminal?.failure?.remediation).includes("persisted alongside"),
    resumeTerminal?.failure?.remediation,
  );

  ok("cancel() before any run is a silent no-op", (() => { fresh.cancel(); return true; })());
}

// --------------------------------------------------- 7. the model registry
{
  const AT = "2026-07-27T12:00:00.000Z";
  const status = (provider, state, method = null) => ({
    provider,
    state,
    method,
    subscriptionTier: state === "authenticated" ? "max" : null,
    probe: "cli_json",
    detail: `${state} (test)`,
    remediation: state === "authenticated" ? "" : "log in",
  });

  const noAuth = S.buildModelCatalogue({
    authStatuses: [status("anthropic", "missing"), status("openai", "missing")],
    atIsoInstant: AT,
    env: {},
  });
  const included = noAuth.entries.filter((e) => e.tier === "included");
  const metered = noAuth.entries.filter((e) => e.tier === "metered");
  ok("the catalogue has both tiers", included.length > 0 && metered.length > 0);
  ok(
    "NOT LOGGED IN: no included model is available",
    included.every((e) => e.available === false),
  );
  ok(
    "...and every one explains itself",
    included.every((e) => e.reason.length > 0 && e.remediation.length > 0),
  );
  ok(
    "NO API KEYS: no metered model is available either",
    metered.every((e) => e.available === false),
  );
  ok(
    "...naming the variable to set",
    metered.every((e) => e.reason.includes(e.envName)),
  );
  ok(
    "INCLUDED ENTRIES CARRY NO COST FIELD AT ALL",
    included.every((e) => S.assertUnpriced(e).length === 0),
    JSON.stringify(included.map((e) => S.assertUnpriced(e)).filter((x) => x.length > 0)),
  );
  ok(
    "...while metered entries DO carry prices, because for them they are real",
    metered.some((e) => e.price !== null && typeof e.price.inputUsdPerMTok === "number"),
  );
  ok(
    "every provider offers a default-model entry that cannot have a wrong id",
    included.some((e) => e.provider === "anthropic" && e.modelId === null && e.modelIdConfirmed) &&
      included.some((e) => e.provider === "openai" && e.modelId === null && e.modelIdConfirmed),
  );
  ok(
    "named included ids are flagged as UNCONFIRMED against the vendor's model list",
    included.filter((e) => e.modelId !== null).every((e) => e.modelIdConfirmed === false),
  );

  const loggedIn = S.buildModelCatalogue({
    authStatuses: [status("anthropic", "authenticated", "claude.ai"), status("openai", "missing")],
    atIsoInstant: AT,
    env: {},
  });
  const anthropicIncluded = loggedIn.entries.filter((e) => e.tier === "included" && e.provider === "anthropic");
  const openaiIncluded = loggedIn.entries.filter((e) => e.tier === "included" && e.provider === "openai");
  ok("a real subscription login makes its models available", anthropicIncluded.every((e) => e.available));
  ok("...and says so", anthropicIncluded.every((e) => e.reason.includes("Included in your")));
  ok("...and records the tier for quota expectations", anthropicIncluded.every((e) => e.subscriptionTier === "max"));
  ok(
    "LIVE NEGATIVE CONTROL: the other provider stays unavailable in the same catalogue",
    openaiIncluded.every((e) => e.available === false),
  );

  const keyed = S.buildModelCatalogue({
    authStatuses: [status("anthropic", "metered_key", "api_key"), status("openai", "missing")],
    atIsoInstant: AT,
    env: {},
  });
  const keyedIncluded = keyed.entries.filter((e) => e.tier === "included" && e.provider === "anthropic");
  ok(
    "AN API KEY DOES NOT UNLOCK THE INCLUDED TIER",
    keyedIncluded.every((e) => e.available === false),
  );
  ok(
    "...and the reason says the path would be billed",
    keyedIncluded.every((e) => /BILLED/i.test(e.reason)),
    keyedIncluded[0]?.reason,
  );

  const weird = S.buildModelCatalogue({
    authStatuses: [status("anthropic", "unknown", "some-new-mode"), status("openai", "missing")],
    atIsoInstant: AT,
    env: {},
  });
  ok(
    "AN UNRECOGNISED AUTH METHOD IS NOT OPTIMISTICALLY ACCEPTED",
    weird.entries
      .filter((e) => e.tier === "included" && e.provider === "anthropic")
      .every((e) => e.available === false),
  );

  const unprobed = S.buildModelCatalogue({ authStatuses: [], atIsoInstant: AT, env: {} });
  ok(
    "a provider that was never probed is unavailable, not assumed working",
    unprobed.entries
      .filter((e) => e.tier === "included")
      .every((e) => e.available === false && e.authState === "unavailable"),
  );

  // Assembled at run time and deliberately NOT key-shaped: no credential-shaped
  // literal exists anywhere in this tree (STATUS.md section 6 item 8), and a
  // `sk-`-prefixed fixture would also be scrubbed by the redactor.
  const fakeCredential = ["fake", "credential", "for", "presence", "check"].join("-");
  ok(
    "a repeated-character fixture is correctly rejected as a placeholder",
    S.buildModelCatalogue({
      authStatuses: [],
      atIsoInstant: AT,
      env: { OPENAI_API_KEY: "x".repeat(40) },
    })
      .entries.filter((e) => e.tier === "metered" && e.provider === "openai")
      .every((e) => e.available === false),
  );

  const withKeys = S.buildModelCatalogue({
    authStatuses: [status("anthropic", "missing"), status("openai", "missing")],
    atIsoInstant: AT,
    env: {
      ANTHROPIC_API_KEY: fakeCredential,
      MOONSHOT_API_KEY: fakeCredential,
      DEEPSEEK_API_KEY: fakeCredential,
      OPENAI_API_KEY: fakeCredential,
    },
  });
  const meteredWithKeys = withKeys.entries.filter((e) => e.tier === "metered");
  ok(
    "with every key set, priced metered models become available",
    meteredWithKeys.some((e) => e.available === true),
  );
  ok("...and the catalogue reports that something is runnable", withKeys.anyAvailable === true);
  ok(
    "a placeholder value is rejected by the existing checkCredential, not re-implemented",
    S.buildModelCatalogue({
      authStatuses: [],
      atIsoInstant: AT,
      env: { OPENAI_API_KEY: "changeme" },
    })
      .entries.filter((e) => e.tier === "metered" && e.provider === "openai")
      .every((e) => e.available === false),
  );
  ok(
    "no metered entry leaks a credential VALUE — only its name",
    !JSON.stringify(meteredWithKeys).includes(fakeCredential),
  );
  ok(
    "...and every metered entry does carry the variable NAME",
    meteredWithKeys.every((e) => typeof e.envName === "string" && e.envName.endsWith("_API_KEY")),
  );
}

// -------------------------------- 8. loadModelCatalogue against real adapters
{
  const catalogue = await S.loadModelCatalogue(
    [
      new S.ClaudeAgentAdapter({ env: isolatedEnv() }),
      new S.CodexAdapter({ env: isolatedEnv() }),
    ],
    { atIsoInstant: "2026-07-27T12:00:00.000Z", env: {} },
  );
  ok("loadModelCatalogue resolves without credentials", catalogue.entries.length > 0);
  ok(
    "against EMPTY credential stores, nothing in the included tier is available",
    catalogue.entries.filter((e) => e.tier === "included").every((e) => e.available === false),
  );
  ok(
    "...and no included entry acquired a cost field on the way through",
    catalogue.entries.filter((e) => e.tier === "included").every((e) => S.assertUnpriced(e).length === 0),
  );
}

// --------------------------- 9. a probe that rejects must not break the API
{
  const exploding = {
    provider: "anthropic",
    displayName: "Exploding",
    cliName: "nope",
    authStatus: async () => {
      throw new Error("probe blew up");
    },
    run: () => (async function* () {})(),
    resume: () => (async function* () {})(),
    cancel: () => {},
  };
  const catalogue = await S.loadModelCatalogue([exploding], { atIsoInstant: "2026-07-27T12:00:00.000Z", env: {} });
  ok("a rejecting probe becomes an entry, not a 500", catalogue.entries.length > 0);
  ok(
    "...marked unavailable with the reason",
    catalogue.entries
      .filter((e) => e.tier === "included" && e.provider === "anthropic")
      .every((e) => e.available === false && e.reason.includes("probe")),
  );
}

// --------------------------------------- 10. LAYER 2 — live 401, opt-in only
if (process.env.BAKEOFF_SUBSCRIPTION_LIVE === "1") {
  // The SDKs are deliberately not dependencies of this package, so point the
  // loader at wherever they ARE installed. BAKEOFF_SUBSCRIPTION_SDK_DIR is the
  // node_modules-bearing directory; without it the default dynamic import is
  // used, which will only work if they happen to be resolvable from here.
  const sdkDir = process.env.BAKEOFF_SUBSCRIPTION_SDK_DIR ?? null;

  /** Resolve a package's ESM entry from its own package.json, not by guessing. */
  const entryOf = (specifier) => {
    const base = join(sdkDir, "node_modules", specifier);
    const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
    const dot = pkg.exports?.["."] ?? {};
    const entry = dot.import ?? dot.default ?? pkg.module ?? pkg.main ?? "index.js";
    return pathToFileURL(join(base, entry)).href;
  };
  const loader = sdkDir === null ? undefined : async (specifier) => import(entryOf(specifier));

  // THE PRE-FLIGHT AUTH GATE IS DELIBERATELY BYPASSED HERE. Without this stub
  // the adapter refuses at `codex login status` and the SDK is never reached —
  // which is the same path Layer 1 already covers, and would leave the SDK's
  // own 401 handling untested while appearing to pass. `CODEX_HOME` still
  // points at an empty directory, so the 401 that follows is REAL.
  const forceAuthenticated = async () => ({
    provider: "openai",
    state: "authenticated",
    method: "test-bypass",
    subscriptionTier: null,
    probe: "cli_text",
    detail: "pre-flight gate bypassed to exercise the SDK's own 401 path",
    remediation: "",
  });
  const codex = new S.CodexAdapter({
    env: isolatedEnv(),
    authProbe: forceAuthenticated,
    ...(loader === undefined ? {} : { loadModule: loader }),
  });
  const started = Date.now();
  const events = await collect("codex LIVE 401", codex.run("say hi", runOptions(gitWorkspace)));
  const elapsedMs = Date.now() - started;
  const terminal = terminalOf(events);
  notes.push(
    `LAYER 2 RAN: ${events.length} events in ${elapsedMs} ms; terminal = ${terminal?.type}/${terminal?.failure?.kind}`,
  );
  ok(
    "LIVE: the real SDK's 401 maps to a failed/auth event, not a crash",
    terminal?.failure?.kind === "auth",
    `${terminal?.failure?.kind}: ${String(terminal?.failure?.message).slice(0, 200)}`,
  );
  ok("LIVE: carrying a structured authStatus of 'missing'", terminal?.failure?.authStatus?.state === "missing");
  ok(
    "LIVE: and the verdict came from the SDK ITSELF, not the CLI pre-flight probe",
    terminal?.failure?.authStatus?.probe === "sdk_error",
    String(terminal?.failure?.authStatus?.probe),
  );
  ok(
    "LIVE: the remediation is the login command",
    String(terminal?.failure?.remediation).includes("codex login"),
  );
  ok(
    "LIVE: a session id was captured BEFORE the failure, so even this run is resumable",
    typeof terminal?.sessionId === "string" && terminal.sessionId.length > 0,
    String(terminal?.sessionId),
  );
  ok("LIVE: the failure is marked resumable", terminal?.failure?.resumable === true);
  ok(
    "LIVE: the run short-circuits the CLI's ten-retry 401 storm (measured at ~20 s unaided)",
    elapsedMs < 15_000,
    `${elapsedMs} ms`,
  );
  ok("LIVE: no emitted event carries a cost field", events.every((e) => S.assertUnpriced(e).length === 0));
  ok(
    "LIVE: nothing in the event stream looks like a stack trace",
    events.every((e) => !looksLikeAStackTrace(JSON.stringify(e))),
  );

  // The Anthropic half, against the REAL module. Section 5b's stub was written
  // from the same .d.ts as the adapter, so a misreading of the type definitions
  // would pass both — this is the case that can disconfirm it.
  //
  // NO QUOTA IS CONSUMED: CLAUDE_CONFIG_DIR points at an empty directory and
  // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are unset, which was measured to
  // produce `loggedIn: false`. Auth fails before any model call. A `completed`
  // terminal here would mean the isolation LEAKED and real quota was spent, so
  // it is asserted as a failure, not accepted as a pass.
  const claudeLive = new S.ClaudeAgentAdapter({
    env: isolatedEnv(),
    authProbe: async () => ({
      provider: "anthropic",
      state: "authenticated",
      method: "test-bypass",
      subscriptionTier: null,
      probe: "cli_json",
      detail: "pre-flight gate bypassed to exercise the real SDK",
      remediation: "",
    }),
    ...(loader === undefined ? {} : { loadModule: loader }),
  });
  const claudeEvents = await collect("claude LIVE", claudeLive.run("say hi", runOptions(gitWorkspace)));
  const claudeTerminal = terminalOf(claudeEvents);
  notes.push(
    `LAYER 2 (anthropic, real SDK): ${claudeEvents.length} events; terminal = ${claudeTerminal?.type}/${claudeTerminal?.failure?.kind ?? "-"}`,
  );
  ok(
    "LIVE anthropic: the real query() matched the structural mirror (it loaded and ran)",
    claudeTerminal !== null,
  );
  ok(
    "LIVE anthropic: an unauthenticated session ends in a FAILED event, never completed",
    claudeTerminal?.type === "failed",
    `${claudeTerminal?.type} — a 'completed' here would mean isolation leaked and quota was spent`,
  );
  ok(
    "LIVE anthropic: the terminal failure is 'auth' — a MID-RUN verdict outranks the pre-flight one",
    claudeTerminal?.failure?.kind === "auth",
    `${claudeTerminal?.failure?.kind} — reporting sdk_error here would tell the owner to debug instead of to log in`,
  );
  ok(
    "LIVE anthropic: it carries the mid-run status, not the stale pre-flight stub",
    claudeTerminal?.failure?.authStatus?.state === "missing" &&
      claudeTerminal?.failure?.authStatus?.method !== "test-bypass",
    JSON.stringify(claudeTerminal?.failure?.authStatus),
  );
  ok(
    "LIVE anthropic: the remediation is the login command",
    String(claudeTerminal?.failure?.remediation).includes("claude setup-token"),
  );
  ok(
    "LIVE anthropic: the real SDK reported apiKeySource outside its own documented union, and the adapter WARNED rather than hard-failing the run",
    claudeEvents.some((e) => e.type === "warning" && e.message.includes("apiKeySource")),
  );
  ok(
    "LIVE anthropic: no stack trace escapes",
    !looksLikeAStackTrace(claudeTerminal?.failure?.message),
    String(claudeTerminal?.failure?.message).slice(0, 200),
  );
  ok(
    "LIVE anthropic: no event carries a cost field",
    claudeEvents.every((e) => S.assertUnpriced(e).length === 0),
  );
} else {
  notes.push(
    "LAYER 2 SKIPPED (needs network + the SDK installed): the LIVE 401 mapping through run() is NOT proved by this run. Set BAKEOFF_SUBSCRIPTION_LIVE=1 (and BAKEOFF_SUBSCRIPTION_SDK_DIR=<dir holding node_modules/@openai/codex-sdk>) to exercise it.",
  );
}

// Best effort. In LAYER 2 the codex CLI writes into the isolated CODEX_HOME and
// may still be flushing when this runs, which surfaces as ENOTEMPTY. A temp
// directory left behind is not a test failure.
try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  notes.push(`scratch dir left behind (a child process was still writing): ${scratch}`);
}

console.log(`${pass} assertions passed, ${failures.length} failed`);
for (const note of notes) console.log(`  NOTE ${note}`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
