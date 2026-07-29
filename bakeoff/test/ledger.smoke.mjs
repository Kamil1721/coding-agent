/**
 * Smoke suite for adapters.ts, ledger.ts and proxy.ts.
 * Runs with NO API keys: the only "credential" is a fake set in this process,
 * which also exercises the redaction chokepoint.
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
const DIST = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "dist");

// A fake credential, set BEFORE importing so redaction picks it up from env.
process.env.ANTHROPIC_API_KEY = ["sk", "ant", "api03", "FAKEfake0123456789abcdefFAKEfake0123"].join("-");
process.env.DEEPSEEK_API_KEY = ["sk", "deepseekFAKE0123456789abcdefghij"].join("-");

const { adapterFor, mergeVendorUsage, assertResponseModel, upstreamBaseUrlFor } = await import(`${DIST}/adapters.js`);
const { RunLedger, KillSwitch, runStatusForKill, readLedgerEvents, ledgerLayout, CampaignSpendLog } = await import(`${DIST}/ledger.js`);
const { BudgetProxy, SseUsageCollector, generateProxyAuthToken, estimateInputTokens } = await import(`${DIST}/proxy.js`);
const { TOKEN_ACCOUNTING_RULE, PRICE_TABLE, priceVendorUsage, resolvePrice } = await import(`${DIST}/contracts.js`);

let passed = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
}
function throws(name, fn, codeWanted) {
  try { fn(); failures.push(`${name} — expected a throw, got none`); }
  catch (e) {
    if (codeWanted && e.code !== codeWanted) failures.push(`${name} — code ${e.code} != ${codeWanted}`);
    else passed += 1;
  }
}
async function throwsAsync(name, fn, codeWanted) {
  try { await fn(); failures.push(`${name} — expected a throw, got none`); }
  catch (e) {
    if (codeWanted && e.code !== codeWanted) failures.push(`${name} — code ${e.code} != ${codeWanted}`);
    else passed += 1;
  }
}

const AT = "2026-07-27T12:00:00.000Z";
const seat = (over = {}) => ({
  role: "subagent", provider: "anthropic", modelId: "claude-sonnet-5", effort: "medium",
  effortSource: "task-spec", envKeyName: "ANTHROPIC_API_KEY", baseUrl: null, notes: "test", ...over,
});
const opusSeat = seat({ role: "orchestrator", modelId: "claude-opus-5", effort: "high" });
const deepseekSeat = seat({ provider: "deepseek", modelId: "deepseek-v4-pro", effort: "max", envKeyName: "DEEPSEEK_API_KEY" });
const moonshotSeat = seat({ provider: "moonshot", modelId: "kimi-k3", effort: "high", envKeyName: "MOONSHOT_API_KEY" });

/* ---------------- adapters ---------------- */
{
  const a = adapterFor("anthropic");
  const row = a.normalizeUsage({
    input_tokens: 1000, output_tokens: 500,
    cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
    output_tokens_details: { thinking_tokens: 120 },
  }, seat(), AT);
  ok("anthropic input", row.inputTokens === 1000);
  ok("anthropic cacheRead", row.cacheReadTokens === 10000);
  ok("anthropic cacheWrite", row.cacheWriteTokens === 2000);
  ok("anthropic thinking", row.thinkingTokens === 120);
  ok("anthropic callCount", row.callCount === 1);
  // intro Sonnet 5: in 2.00, read 0.20, write5m 2.50, out 10.00 per MTok
  const want = (1000 * 2 + 10000 * 0.2 + 2000 * 2.5 + 500 * 10) / 1e6;
  ok("anthropic cost", Math.abs(row.costUsd - want) < 1e-12, `${row.costUsd} vs ${want}`);

  throws("anthropic missing cache_read throws", () =>
    a.normalizeUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0 }, seat(), AT),
    "invalid_usage_shape");
  throws("anthropic absent field is never 0", () =>
    a.normalizeUsage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }, seat(), AT),
    "invalid_usage_shape");
  throws("anthropic split mismatch throws", () =>
    a.normalizeUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 40 },
    }, seat(), AT), "invalid_usage_shape");
  throws("wrong-provider seat rejected", () => a.normalizeUsage({}, deepseekSeat, AT), "invalid_usage_shape");

  // price window: Sonnet 5 rises 2026-09-01
  const later = a.normalizeUsage({
    input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }, seat(), "2026-09-02T00:00:00.000Z");
  ok("price window rise applied", Math.abs(later.costUsd - 3.0) < 1e-12, String(later.costUsd));
}
{
  const d = adapterFor("deepseek");
  const native = d.normalizeUsage({
    prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100,
    prompt_tokens: 1000, completion_tokens: 50,
  }, deepseekSeat, AT);
  ok("deepseek native hit->cacheRead", native.cacheReadTokens === 900);
  ok("deepseek native miss->input", native.inputTokens === 100);
  ok("deepseek cacheWrite forced 0", native.cacheWriteTokens === 0);
  throws("deepseek non-zero cache_creation throws", () =>
    d.normalizeUsage({
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 7,
    }, deepseekSeat, AT), "invalid_usage_shape");
  throws("deepseek prompt_tokens mismatch throws", () =>
    d.normalizeUsage({
      prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 1, prompt_tokens: 99, completion_tokens: 1,
    }, deepseekSeat, AT), "invalid_usage_shape");
  throws("deepseek unknown shape throws", () =>
    d.normalizeUsage({ total_tokens: 5 }, deepseekSeat, AT), "invalid_usage_shape");
}
{
  const m = adapterFor("moonshot");
  const row = m.normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 },
  }, moonshotSeat, AT);
  ok("moonshot cached->cacheRead", row.cacheReadTokens === 600);
  ok("moonshot uncached->input", row.inputTokens === 400);
  throws("moonshot cached>prompt throws", () =>
    m.normalizeUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 99 } },
      moonshotSeat, AT), "invalid_usage_shape");
  throws("moonshot no cache fields throws", () =>
    m.normalizeUsage({ prompt_tokens: 10, completion_tokens: 1 }, moonshotSeat, AT), "invalid_usage_shape");
}
{
  // worst case: input at the HIGHEST input-side rate (opus 1h write = 10.0), output at full max_tokens
  const cost = adapterFor("anthropic").worstCaseCallCostUsd(opusSeat, 1_000_000, 1_000_000, AT);
  ok("worstCase uses highest input-side rate", Math.abs(cost - (10.0 + 25.0)) < 1e-9, String(cost));
  // A MODEL WITH NO PRICE IS AN UNCAPPED MODEL, and the pre-call ceiling must
  // refuse it. Two distinct ways a price can be absent, and both must throw.
  //
  // NOTE, 2026-07-27 (owner decision D3): this check used to name
  // openai/gpt-5.6-luna, which was the tree's only null-priced entry. That
  // entry is now verified-priced, so naming it here would silently stop
  // exercising the control — the test would pass because the model became
  // priced, not because the refusal works.
  //
  // (1) no PRICE_TABLE window covers the model at all.
  throws("worstCase rejects a model with no price window", () =>
    adapterFor("openai").worstCaseCallCostUsd(
      seat({ provider: "openai", modelId: "gpt-5.6-unpriced-fixture", effort: "medium", envKeyName: "OPENAI_API_KEY" }),
      100, 100, AT), "unknown_model_price");

  // (2) a window exists but the field the usage touches is null.
  const nullPriced = {
    price: {
      ...PRICE_TABLE[0],
      modelId: "fixture-null-priced",
      inputUsdPerMTok: null,
      fieldStatus: { ...PRICE_TABLE[0].fieldStatus, input: "unverified" },
    },
    assumedFields: [],
    unverifiedFields: ["input"],
  };
  throws("pricing refuses a null-priced field rather than costing it as zero", () =>
    priceVendorUsage(
      { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
        cacheWrite5mTokens: null, cacheWrite1hTokens: null },
      nullPriced), "unpriced_usage");

  // The three OpenAI entries D3 added resolve, and resolve as verified.
  for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    const resolved = resolvePrice("openai", modelId, AT);
    ok(`openai/${modelId} is priced with no unverified field`,
      resolved.unverifiedFields.length === 0 && resolved.price.inputUsdPerMTok !== null,
      JSON.stringify(resolved.unverifiedFields));
  }
}
{
  const a = adapterFor("anthropic").normalizeUsage(
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, seat(), AT);
  const b = adapterFor("deepseek").normalizeUsage(
    { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1, completion_tokens: 1 }, deepseekSeat, AT);
  throws("merge across vendors refused", () => mergeVendorUsage(a, b), "invalid_usage_shape");
  const merged = mergeVendorUsage(a, a);
  ok("merge same class sums", merged.inputTokens === 2 && merged.callCount === 2);
  ok("merge keeps thinking null", merged.thinkingTokens === null);
}
{
  assertResponseModel("claude-opus-5", "claude-opus-5-20260114"); passed += 1;
  throws("model substitution caught (pro->flash)", () =>
    assertResponseModel("deepseek-v4-pro", "deepseek-v4-flash"), "invalid_usage_shape");
  throws("missing response model caught", () => assertResponseModel("x", null), "invalid_usage_shape");
  ok("deepseek default endpoint is the anthropic-format one",
    upstreamBaseUrlFor(deepseekSeat) === "https://api.deepseek.com/anthropic");
}

/* ---------------- ledger ---------------- */
const root = mkdtempSync(join(tmpdir(), "bakeoff-smoke-"));
const campaignDir = join(root, "ledger");
const heldConstants = {
  efforts: [], harness: { id: "t", version: "0", commit: "unversioned" },
  sandbox: { imageRef: "x", imageDigest: "sha256:" + "a".repeat(64), networkPolicy: { egress: "denied", allowedHosts: [] } },
  repeatCount: 1, acceptanceSuiteSha256: "b".repeat(64), tokenAccountingRule: TOKEN_ACCOUNTING_RULE,
};
const budget = (over = {}) => ({
  maxCostUsd: 10, maxWallClockMs: 60_000, maxCampaignCostUsd: 100, warnAtFraction: 0.8,
  perVendorMaxOutputTokens: null, vendorAdvisoryBudgets: [], ...over,
});
function openLedger(runId, over = {}, dir = root) {
  const runResultsDir = join(dir, "runs", runId);
  return RunLedger.open({
    runId, ticketId: "T1", configId: "A", repeatIndex: 0, phase: "screen",
    budget: budget(over), heldConstants, runResultsDir, campaignDir,
    startedAt: AT, killSwitch: new KillSwitch(join(campaignDir, "KILL")),
  });
}
{
  const l = openLedger("r1");
  const d = l.precall({ seat: seat(), plannedMaxOutputTokens: 1000, estimatedInputTokens: 1000, estimatorBasis: "test" });
  ok("precall allows under ceiling", d.allowed === true && d.killReason === null);
  ok("precall reports worst case", d.worstCaseNextCallUsd > 0);
  ok("precall ceiling matches budget", d.ceilingUsd === 10);

  // A call whose worst case alone blows the ceiling is denied BEFORE dispatch.
  const d2 = l.precall({ seat: seat(), plannedMaxOutputTokens: 100_000_000, estimatedInputTokens: 1000, estimatorBasis: "test" });
  ok("precall denies on cost ceiling", d2.allowed === false && d2.killReason === "cost_ceiling_usd");
  ok("kill recorded once", l.killSignal()?.reason === "cost_ceiling_usd");
  l.close(runStatusForKill(l.killSignal().reason));

  const events = readLedgerEvents(l.layout.runEventsPath);
  ok("ledger seq gap-free", events.every((e, i) => e.seq === i + 1));
  ok("ledger has run_started", events[0].kind === "run_started");
  ok("ledger has kill_issued", events.some((e) => e.kind === "kill_issued"));
  ok("ledger has run_ended budget_exceeded", events.at(-1).kind === "run_ended" && events.at(-1).status === "budget_exceeded");
}
{
  ok("wall clock maps to timeout", runStatusForKill("wall_clock_ceiling") === "timeout");
  ok("infra maps to error", runStatusForKill("infrastructure_failure") === "error");
  ok("operator abort maps to budget_exceeded", runStatusForKill("operator_abort") === "budget_exceeded");
}
{
  // Wall-clock boundary denies before the call.
  const l = openLedger("r-wall", { maxWallClockMs: -1 });
  const d = l.precall({ seat: seat(), plannedMaxOutputTokens: 10, estimatedInputTokens: 10, estimatorBasis: "t" });
  ok("wall clock boundary denies", d.allowed === false && d.killReason === "wall_clock_ceiling");
  l.close("timeout");
}
{
  // Per-vendor output-token ceiling, per provider and never cross-vendor.
  const l = openLedger("r-tok", { perVendorMaxOutputTokens: { anthropic: 100 } });
  const d = l.precall({ seat: seat(), plannedMaxOutputTokens: 101, estimatedInputTokens: 1, estimatorBasis: "t" });
  ok("vendor token ceiling denies", d.allowed === false && d.killReason === "vendor_output_token_ceiling");
  l.close("budget_exceeded");
  const l2 = openLedger("r-tok2", { perVendorMaxOutputTokens: { moonshot: 1 } });
  const d2 = l2.precall({ seat: seat(), plannedMaxOutputTokens: 5000, estimatedInputTokens: 1, estimatorBasis: "t" });
  ok("other vendor's ceiling does not apply", d2.allowed === true);
  l2.close("completed");
}
{
  // Campaign spend is read FROM DISK, so a second process sees the first's spend.
  const l = openLedger("r-camp1", { maxCampaignCostUsd: 1000 });
  const row = adapterFor("anthropic").normalizeUsage(
    { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, seat(), AT);
  l.recordUsage(row, { httpStatus: 200, streamed: true });   // $2.00
  l.close("completed");
  const l2 = openLedger("r-camp2", { maxCampaignCostUsd: 1000 });
  ok("campaign spend crosses ledger instances", Math.abs(l2.campaignCostUsd() - 2.0) < 1e-9, String(l2.campaignCostUsd()));
  ok("run total is separate from campaign total", l2.totalCostUsd() === 0);
  const d = l2.precall({ seat: seat(), plannedMaxOutputTokens: 10, estimatedInputTokens: 10, estimatorBasis: "t" });
  ok("campaign ceiling not yet reached", d.allowed === true);
  l2.close("completed");

  const l3 = openLedger("r-camp3", { maxCampaignCostUsd: 2.5 });
  const d3 = l3.precall({ seat: seat(), plannedMaxOutputTokens: 1_000_000, estimatedInputTokens: 0, estimatorBasis: "t" });
  ok("campaign ceiling denies", d3.allowed === false && d3.killReason === "campaign_cost_ceiling_usd");
  ok("campaign boundary engages the global sentinel", existsSync(join(campaignDir, "KILL")));
  l3.close("budget_exceeded");
  rmSync(join(campaignDir, "KILL"), { force: true });
}
{
  // Cache alerts: both-zero across consecutive calls in one class.
  const l = openLedger("r-cache");
  const cold = adapterFor("anthropic").normalizeUsage(
    { input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, seat(), AT);
  l.recordUsage(cold, { httpStatus: 200, streamed: true });
  const alertsPath = l.layout.runAlertsPath;
  ok("no alert after one both-zero call", !existsSync(alertsPath) || !readFileSync(alertsPath, "utf8").includes("cache_never_engaged"));
  l.recordUsage(cold, { httpStatus: 200, streamed: true });
  const alerts = readFileSync(alertsPath, "utf8");
  ok("cache_never_engaged alert fires on the second", alerts.includes("cache_never_engaged"));
  ok("alert is keyed by call class", alerts.includes("anthropic|claude-sonnet-5|subagent"));

  // A different class must not be masked by the first.
  const warm = adapterFor("anthropic").normalizeUsage(
    { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, opusSeat, AT);
  l.recordUsage(warm, { httpStatus: 200, streamed: true });
  l.recordUsage(warm, { httpStatus: 200, streamed: true });
  const perProvider = l.cacheHitFractionByProvider();
  ok("cache-hit fraction reported per provider", typeof perProvider.anthropic === "number");
  ok("usage rows are one per class", l.usageRows().length === 2);
  l.close("completed");
}
{
  // Redaction: nothing persisted may contain the credential value.
  const l = openLedger("r-redact");
  l.recordHarnessError(`upstream said ${process.env.ANTHROPIC_API_KEY} was bad`);
  l.alert("usage_not_costed", "c", `token ${process.env.ANTHROPIC_API_KEY}`, "fix it");
  l.close("error");
  const events = readFileSync(l.layout.runEventsPath, "utf8");
  const alerts = readFileSync(l.layout.runAlertsPath, "utf8");
  ok("ledger has no credential value", !events.includes(process.env.ANTHROPIC_API_KEY));
  ok("alerts have no credential value", !alerts.includes(process.env.ANTHROPIC_API_KEY));
  ok("alerts show the redaction placeholder", alerts.includes("[REDACTED:ANTHROPIC_API_KEY]"));
  ok("harness errors are redacted in memory too", !l.harnessErrors()[0].includes(process.env.ANTHROPIC_API_KEY));
}
{
  const layout = ledgerLayout("/c", "/r");
  ok("call stream is not collected as a result file", layout.runCallsPath.endsWith(".ndjson"));
  ok("ledger stream IS collected as a result file", layout.runEventsPath.endsWith(".jsonl"));
  ok("campaign spend is not a result file", layout.campaignSpendPath.endsWith(".ndjson"));
}
{
  const ks = new KillSwitch(join(root, "ks", "KILL"));
  ok("switch starts disengaged", ks.engaged() === null);
  ks.engage("operator_abort", "test");
  ok("switch engages", ks.engaged()?.reason === "operator_abort");
  ok("sentinel readable by another process", KillSwitch.read(join(root, "ks", "KILL"))?.reason === "operator_abort");
  ok("clear removes it", KillSwitch.clear(join(root, "ks", "KILL")) === true);
}

/* ---------------- SSE collector ---------------- */
{
  const c = new SseUsageCollector();
  c.push('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":0,"output_tokens":3}}}\n\n');
  c.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":250}}\n\n');
  const r = c.result();
  ok("collector takes input from message_start", r.usage.input_tokens === 10 && r.usage.cache_read_input_tokens === 900);
  ok("collector takes output from the LAST delta, never summed", r.usage.output_tokens === 250);
  ok("collector reads the served model", r.model === "claude-sonnet-5");

  // split across chunk boundaries
  const c2 = new SseUsageCollector();
  const frame = 'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n';
  c2.push(frame.slice(0, 40)); c2.push(frame.slice(40));
  ok("collector reassembles split frames", c2.result().usage.input_tokens === 5);
  ok("estimator over-estimates (chars/2)", estimateInputTokens("abcd") === 2);
}

/* ---------------- proxy against a fake upstream ---------------- */
let upstreamCalls = 0;
let lastUpstreamBody = null;
let lastAuthHeader = null;
let respondWith = "sse";
const upstream = createServer((req, res) => {
  upstreamCalls += 1;
  lastAuthHeader = req.headers["x-api-key"] ?? req.headers["authorization"] ?? null;
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    lastUpstreamBody = JSON.parse(body);
    if (respondWith === "unary") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        model: lastUpstreamBody.model, content: [],
        usage: { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
      return;
    }
    if (respondWith === "substitute") {
      res.setHeader("content-type", "text/event-stream");
      res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-flash","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n');
      res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n');
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.write(`event: message_start\ndata: {"type":"message_start","message":{"model":"${lastUpstreamBody.model}","usage":{"input_tokens":100,"cache_read_input_tokens":9000,"cache_creation_input_tokens":0,"output_tokens":4}}}\n\n`);
    res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":400}}\n\n');
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const routedSeat = seat({ baseUrl: upstreamUrl });
const routedOpus = { ...opusSeat, baseUrl: upstreamUrl };
{
  const ledger = openLedger("r-proxy", { maxCostUsd: 50, maxCampaignCostUsd: 10_000 });
  const token = generateProxyAuthToken();
  const proxy = await BudgetProxy.start({
    ledger, authToken: token,
    routes: [
      { seat: routedOpus, requestModelPrefixes: ["claude-opus"] },
      { seat: routedSeat, requestModelPrefixes: ["claude-sonnet"] },
    ],
  });

  // unauthenticated
  const bad = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, stream: true }),
  });
  ok("proxy rejects an unauthenticated caller", bad.status === 401);
  ok("no upstream call was made", upstreamCalls === 0);
  // The seal probe identifies the proxy by this header. Without it the probe
  // can only show that something answered, which is not the property held
  // -constant variable 3 requires.
  ok("proxy stamps its identity header on errors", bad.headers.get("x-bakeoff-proxy") === "1");

  // authenticated streamed call
  const call = (body, headers = {}) => fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token, ...headers },
    body: JSON.stringify(body),
  });
  const res = await call({ model: "claude-sonnet-4-5", max_tokens: 1000, stream: true });
  const text = await res.text();
  ok("proxy forwards and returns 200", res.status === 200);
  ok("proxy streams the body through unchanged", text.includes("message_delta"));
  ok("proxy rewrote the alias to the seat's real model id", lastUpstreamBody.model === "claude-sonnet-5");
  ok("proxy injected the real credential, not the sandbox token",
    lastAuthHeader === process.env.ANTHROPIC_API_KEY);
  ok("sandbox token never reaches upstream", lastAuthHeader !== token);

  const rows = ledger.usageRows();
  ok("usage recorded from the wire", rows.length === 1);
  ok("output taken from the final delta (400, not 404)", rows[0].outputTokens === 400);
  ok("cache read recorded", rows[0].cacheReadTokens === 9000);
  ok("row is tagged with the seat role", rows[0].role === "subagent");

  // orchestrator alias routes to the other seat
  await call({ model: "claude-opus-4-5", max_tokens: 10, stream: true });
  ok("orchestrator alias routes to the orchestrator seat", lastUpstreamBody.model === "claude-opus-5");
  ok("two classes are kept apart", ledger.usageRows().length === 2);

  // non-streaming
  respondWith = "unary";
  await call({ model: "claude-sonnet-4-5", max_tokens: 10 });
  const sonnetRow = ledger.usageRows().find((r) => r.modelId === "claude-sonnet-5");
  ok("non-streaming usage recorded", sonnetRow.outputTokens === 400 + 11);
  ok("non-streaming call merged into the same class", sonnetRow.callCount === 2);
  respondWith = "sse";

  // unroutable model
  const unroutable = await call({ model: "gpt-4o", max_tokens: 10 });
  ok("unroutable model is refused", unroutable.status === 400);

  const before = upstreamCalls;
  ok("proxy stats count requests", proxy.stats().requests >= 4);
  ok("no extra upstream calls from a refusal", upstreamCalls === before);
  await proxy.stop();
  ledger.close("completed");
}
{
  // The ceiling denies BEFORE the request leaves the harness.
  const ledger = openLedger("r-deny", { maxCostUsd: 0.0001, maxCampaignCostUsd: 10_000 });
  const token = generateProxyAuthToken();
  const proxy = await BudgetProxy.start({
    ledger, authToken: token, routes: [{ seat: routedSeat, requestModelPrefixes: ["claude-sonnet"] }],
  });
  const before = upstreamCalls;
  const res = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 100000, stream: true }),
  });
  ok("proxy denies on the boundary", res.status === 403);
  const body = await res.json();
  ok("denial names the boundary", body.error.type === "bakeoff_budget_boundary");
  ok("NO upstream call was made", upstreamCalls === before);
  ok("ledger recorded the kill", ledger.killSignal()?.reason === "cost_ceiling_usd");
  ok("no usage recorded for a denied call", ledger.usageRows().length === 0);
  await proxy.stop();
  ledger.close("budget_exceeded");
}
{
  // Model substitution: DeepSeek serving Flash where Pro was requested.
  const ledger = openLedger("r-sub", { maxCostUsd: 50, maxCampaignCostUsd: 10_000 });
  const token = generateProxyAuthToken();
  respondWith = "substitute";
  const proxy = await BudgetProxy.start({
    ledger, authToken: token,
    routes: [{ seat: { ...deepseekSeat, baseUrl: upstreamUrl }, requestModelPrefixes: ["claude-sonnet"] }],
  });
  await fetch(`${proxy.url}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, stream: true }),
  });
  ok("substitution kills the run", ledger.killSignal()?.reason === "infrastructure_failure");
  const alerts = readFileSync(ledger.layout.runAlertsPath, "utf8");
  ok("substitution is alerted", alerts.includes("model_substitution"));
  ok("substituted call is not costed", ledger.usageRows().length === 0);
  respondWith = "sse";
  await proxy.stop();
  ledger.close("error");
}
{
  // A seat whose vendor does not speak the Anthropic wire format is refused up front.
  const ledger = openLedger("r-wire");
  process.env.OPENAI_API_KEY = ["sk", "openaiFAKE0123456789abcdefghij"].join("-");
  await throwsAsync("openai seat refused by the proxy", async () => {
    await BudgetProxy.start({
      ledger, authToken: "t",
      routes: [{ seat: seat({ provider: "openai", modelId: "gpt-5.6-luna", effort: "medium", envKeyName: "OPENAI_API_KEY" }), requestModelPrefixes: [] }],
    });
  }, "not_implemented");
  delete process.env.OPENAI_API_KEY;

  await throwsAsync("missing credential fails clean before any spend", async () => {
    await BudgetProxy.start({
      ledger, authToken: "t", env: {},
      routes: [{ seat: routedSeat, requestModelPrefixes: [] }],
    });
  }, "missing_credential");
  ledger.close("error");
}

await new Promise((r) => upstream.close(r));

console.log(`\npassed: ${passed}`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all assertions passed");
rmSync(root, { recursive: true, force: true });
