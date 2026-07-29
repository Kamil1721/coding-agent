/**
 * End-to-end: DockerRunner against a REAL sealed container and a fake upstream
 * on the host. No API key and no vendor is involved.
 *
 * What it proves, on every run:
 *   - `docker network create --internal` really denies egress, checked from
 *     INSIDE the container (public IP and external DNS both unreachable);
 *   - the relay sidecar is reachable and is the only route out;
 *   - a request from the builder passes the pre-call ceiling check, reaches the
 *     upstream with the REAL credential substituted for the sandbox token, and
 *     is costed from the vendor's own usage payload;
 *   - `agentDeclaredDone` comes from the structured self-report file;
 *   - no credential and no proxy token survives into any persisted artefact.
 *
 * REQUIRES: docker, and the image below present locally. If the digest no
 * longer matches, `docker pull node:22` and update IMAGE_DIGEST — the runner
 * refuses an image that is not pinned by content digest, which is the point.
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
const DIST = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "dist");
process.env.ANTHROPIC_API_KEY = ["sk", "ant", "api03", "FAKEfake0123456789abcdefFAKEfake0123"].join("-");

const { DockerRunner } = await import(`${DIST}/runner.js`);
const { KillSwitch } = await import(`${DIST}/ledger.js`);
const { ticketDigest } = await import(`${DIST}/hash.js`);
const { getConfig, heldConstantsFor, SEALED_NETWORK_POLICY, DEFAULT_BUDGET } = await import(`${DIST}/config.js`);

const IMAGE_REF = "node:22";
const IMAGE_DIGEST = "sha256:a25c9934ff6382cd4f08b6bc26c82bf4ea69b1e6f8dabfb2ead457374127c365";

let upstreamCalls = 0;
const upstream = createServer((req, res) => {
  upstreamCalls += 1;
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      model: parsed.model, content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
    }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
console.log(`fake upstream: ${upstreamUrl}`);

const root = mkdtempSync(join(tmpdir(), "bakeoff-e2e-"));
const brief = "Write a file called HELLO.txt containing the word hello.";
const ticket = { id: "T1", tier: "trivial", title: "t", brief, sha256: ticketDigest(brief) };

// Point both seats at the fake upstream. The config's own seats are frozen, so
// the baseUrl override is applied to copies here, exactly as an operator would
// do with ANTHROPIC_BASE_URL.
const base = getConfig("A");
const config = {
  ...base,
  seats: base.seats.map((s) => (s.role === "orchestrator" || s.role === "subagent" ? { ...s, baseUrl: upstreamUrl } : s)),
};

const BUILDER_SCRIPT = `
const url = process.env.ANTHROPIC_BASE_URL + "/v1/messages";
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_AUTH_TOKEN },
  body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
});
console.log("builder: proxy replied " + res.status);
const { mkdirSync, writeFileSync } = await import("node:fs");
writeFileSync("/workspace/HELLO.txt", "hello\\n");
mkdirSync("/workspace/.bakeoff", { recursive: true });
writeFileSync("/workspace/.bakeoff/self-report.json", JSON.stringify({ status: "done", reason: "wrote the file" }));
// Prove the sandbox cannot reach the internet even though the proxy works.
try {
  await fetch("https://registry.npmjs.org/", { signal: AbortSignal.timeout(3000) });
  console.log("builder: EGRESS REACHED THE INTERNET");
} catch { console.log("builder: internet unreachable, as required"); }
`;

const sandbox = { imageRef: IMAGE_REF, imageDigest: IMAGE_DIGEST, networkPolicy: SEALED_NETWORK_POLICY };
const harness = { id: "bakeoff", version: "0.1.0", commit: "unversioned" };
const campaignDir = join(root, "ledger");

const runner = new DockerRunner({
  harness, sandbox, campaignDir,
  killSwitch: new KillSwitch(join(campaignDir, "KILL")),
  phase: "screen",
  acceptanceRoot: join(root, "acceptance"),
  builderCommand: { argv: ["node", "-e", BUILDER_SCRIPT], notes: "e2e test builder" },
});

const record = await runner.run({
  runId: "e2e-A-T1-r0",
  ticket, config, repeatIndex: 0,
  budget: { ...DEFAULT_BUDGET, maxWallClockMs: 180_000, maxCostUsd: 5 },
  heldConstants: heldConstantsFor({
    config, harness, sandbox, repeatCount: 1, acceptanceSuiteSha256: "d".repeat(64),
  }),
  workspaceDir: join(root, "workspaces", "e2e-A-T1-r0"),
  resultsDir: join(root, "runs", "e2e-A-T1-r0"),
});

const resultsDir = join(root, "runs", "e2e-A-T1-r0");
const outcome = JSON.parse(readFileSync(join(resultsDir, "runner-outcome.json"), "utf8"));
const log = existsSync(join(resultsDir, "run.log")) ? readFileSync(join(resultsDir, "run.log"), "utf8") : "";

console.log("\n--- run log ---");
console.log(log.trim().split("\n").slice(-12).join("\n"));
console.log("\n--- result ---");
console.log(JSON.stringify({
  status: record.status,
  killReason: record.killReason,
  agentDeclaredDone: record.agentDeclaredDone,
  totalCostUsd: record.totalCostUsd,
  usage: record.usage.map((u) => ({ p: u.provider, m: u.modelId, role: u.role, in: u.inputTokens, cr: u.cacheReadTokens, out: u.outputTokens, cost: u.costUsd })),
  harnessErrors: record.harnessErrors,
  exit: outcome.containerExitCode,
  probe: outcome.sealProbe,
  selfReport: outcome.selfReport,
  forbidden: outcome.forbiddenPathViolations,
  proxy: { requests: outcome.proxyRequests, denied: outcome.proxyDenied, uncosted: outcome.proxyUncosted },
  upstreamCalls,
}, null, 2));

const checks = [
  ["container ran", outcome.containerExitCode === 0],
  ["seal probe present", outcome.sealProbe !== null],
  ["egress denied", outcome.sealProbe?.egressDenied === true],
  ["proxy reachable from inside", outcome.sealProbe?.proxyReachable === true],
  // The probe must prove WHICH service it reached, not merely that something
  // answered: a stale relay or a port collision would satisfy the weaker test.
  ["the route ends at THIS proxy, with auth enforced",
    outcome.sealProbe?.detail.includes("status 401") && outcome.sealProbe?.detail.includes("identity 1")],
  ["builder reached the proxy", upstreamCalls === 1],
  ["usage recorded", record.usage.length === 1],
  ["cost > 0", record.totalCostUsd > 0],
  ["agentDeclaredDone from structured signal", record.agentDeclaredDone === true],
  ["status completed", record.status === "completed"],
  ["no forbidden paths", outcome.forbiddenPathViolations.length === 0],
  ["workspace has the built file", existsSync(join(root, "workspaces", "e2e-A-T1-r0", "HELLO.txt"))],
  ["ticket brief mounted", existsSync(join(root, "workspaces", "e2e-A-T1-r0", "TICKET.md"))],
  ["run.jsonl written for the reporter", existsSync(join(resultsDir, "run.jsonl"))],
  ["log contains no credential", !log.includes(process.env.ANTHROPIC_API_KEY)],
  ["docker argv redacted", !readFileSync(join(resultsDir, "docker-argv.json"), "utf8").includes(process.env.ANTHROPIC_API_KEY)],
];
console.log("\n--- checks ---");
let bad = 0;
for (const [name, cond] of checks) { if (!cond) bad += 1; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); }
await new Promise((r) => upstream.close(r));
process.exit(bad === 0 ? 0 : 1);
