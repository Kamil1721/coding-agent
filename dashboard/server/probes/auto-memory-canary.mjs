/**
 * T5 — sealed-seat auto-memory canary for Claude Agent SDK 0.3.220 / Claude Code 2.1.220.
 *
 * This is an OFFLINE wire probe. SubscriptionSeatCaller first assembles the exact
 * production no-attachment {prompt, options}; its injectable startQuery seam
 * records those values without starting Claude Code. The real SDK query is then
 * exercised with only two probe additions: inline settings pointing at a fresh
 * auto-memory directory, and a spawn wrapper that launches the SDK-supplied
 * bundled CLI command/argv with dummy auth against a loopback fake Anthropic API.
 *
 * The fake API records the prompt-bearing /v1/messages JSON, returns a
 * deterministic 400, then sends SIGTERM after capture to prevent the client's
 * retry policy from issuing another request. The child receives a fixed
 * environment allowlist, dummy auth, and a loopback Anthropic endpoint. This is
 * not an OS-level egress sandbox; the evidence proves the captured API traffic
 * was loopback and that no live model response was requested.
 *
 * Usage:
 *   npm run build --silent
 *   node probes/auto-memory-canary.mjs
 *   node probes/auto-memory-canary.mjs --mutate-disable-control
 *
 * The mutation mode deliberately removes CLAUDE_CODE_DISABLE_AUTO_MEMORY from
 * the disabled probe arm after recording the production dispatch. It must exit
 * red and NEVER writes the canonical result, including after the guard ships.
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { SPEC_SEAT } from "bakeoff/dist/config.js";

import { DISABLE_AUTO_MEMORY_ENV, SubscriptionSeatCaller } from "../dist/subscription-caller.js";
import { STRIPPED_ENV_NAMES } from "../dist/subprocess-env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = dirname(HERE);
const RESULT_PATH = join(HERE, "results", "auto-memory-canary.json");
const FAILURE_RESULT_PATH = join(HERE, "results", "auto-memory-canary.failure.json");
const MUTATION_RESULT_PATH = join(HERE, "results", "auto-memory-canary.mutation.json");
const SOURCE_PATH = fileURLToPath(import.meta.url);
const SDK_PACKAGE_PATH = join(
  SERVER_ROOT,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "package.json",
);

const HARD_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const EXACT_QUESTION =
  "Does the real bundled Claude Code request assembled for a production sealed seat include a " +
  "token that exists only in a scratch cross-run auto-memory MEMORY.md file, and does " +
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 remove it?";
const SEAT_SYSTEM_PROMPT =
  "You are a sealed evaluation seat. Follow the user request exactly. You have no tools.";
const SEAT_PROMPT = "Reply with exactly the word READY and nothing else.";

const PROBE_BUDGET = Object.freeze({
  maxCostUsd: 1,
  maxWallClockMs: 60_000,
  maxCampaignCostUsd: 1,
  warnAtFraction: 0.8,
  perVendorMaxOutputTokens: null,
  vendorAdvisoryBudgets: [],
});

const SEAT_REQUEST = Object.freeze({
  system: SEAT_SYSTEM_PROMPT,
  userTurns: [SEAT_PROMPT],
  maxOutputTokens: 1_024,
  jsonSchema: null,
  purpose: "T5 offline auto-memory wire canary",
});

const TRANSPORT_CREDENTIAL_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
]);
const ENDPOINT_SELECTOR_NAMES = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);
const PROXY_NAMES = Object.freeze([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
]);

// Nothing else from the owner's shell reaches the probe child. In particular,
// alternate-provider selectors and credentials are omitted by construction,
// including provider families added by future CLI releases.
const PROBE_ENV_PASSTHROUGH_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  DISABLE_AUTO_MEMORY_ENV,
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CONFIG_DIR",
]);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function fileSha256(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function keySetProjection(env) {
  const keys = Object.keys(env ?? {}).sort();
  return {
    keyCount: keys.length,
    keySetSha256: sha256(JSON.stringify(keys)),
    keysSerialized: false,
    hashBasis: "JSON of sorted environment key names; neither names nor values are serialized",
  };
}

function presence(env, key) {
  return Object.prototype.hasOwnProperty.call(env ?? {}, key) ? "present" : "absent";
}

function controlState(env) {
  if (!Object.prototype.hasOwnProperty.call(env ?? {}, DISABLE_AUTO_MEMORY_ENV)) return "absent";
  return env[DISABLE_AUTO_MEMORY_ENV] === "1" ? "1" : "present-non-1-value-redacted";
}

function cloneSerializable(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function projectedOption(options, key) {
  const present = Object.prototype.hasOwnProperty.call(options, key);
  return {
    present,
    value: present ? cloneSerializable(options[key]) : null,
  };
}

function sanitizeStringForPersistence(value) {
  let sanitized = value;
  const userHome = process.env.HOME;
  if (typeof userHome === "string" && userHome.length > 1) {
    sanitized = sanitized.replaceAll(userHome, "<user-home>");
  }
  const scratchMarker = sanitized.indexOf("t5-auto-memory-");
  if (scratchMarker !== -1) {
    const slashAfter = sanitized.slice(scratchMarker).search(/[\\/]/);
    const suffixStart = slashAfter === -1 ? sanitized.length : scratchMarker + slashAfter;
    sanitized = `<scratch-root>${sanitized.slice(suffixStart)}`;
  }
  return sanitized;
}

function sanitizeForPersistence(value, parentKey = null) {
  if (typeof value === "string") return sanitizeStringForPersistence(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForPersistence(item, parentKey));
  if (value === null || typeof value !== "object") return value;

  const out = {};
  const legacyEnvironmentProjection =
    Array.isArray(value.keys) &&
    typeof value.keySetSha256 === "string" &&
    typeof value.hashBasis === "string";
  for (const [key, item] of Object.entries(value)) {
    if (parentKey === "metadata") {
      out[key] = { present: true, type: Array.isArray(item) ? "array" : typeof item, serialized: false };
      continue;
    }
    if (legacyEnvironmentProjection && key === "keys") {
      out.keyCount = item.length;
      out.keysSerialized = false;
      continue;
    }
    if (key === "rawBodyWhenInvalidJson") {
      out.invalidRawBody =
        item === null
          ? null
          : {
              present: typeof item === "string" && item.length > 0,
              byteLength: typeof item === "string" ? Buffer.byteLength(item) : null,
              serialized: false,
            };
      continue;
    }
    if (
      key === "command" &&
      typeof value.commandBasename === "string" &&
      /^(?:claude|claude\.exe)$/i.test(value.commandBasename)
    ) {
      out.command = "<sdk-bundled-cli-path-redacted>";
      out.commandPathSerialized = false;
      continue;
    }
    out[key] = sanitizeForPersistence(item, key);
  }
  return out;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(sanitizeForPersistence(value), null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function projectProductionOptions(options) {
  const env = options.env ?? {};
  const envProjection = keySetProjection(env);
  return {
    abortController: {
      present: options.abortController !== undefined,
      aborted: options.abortController?.signal?.aborted ?? null,
    },
    cwd: options.cwd ?? null,
    model: options.model ?? null,
    effort: projectedOption(options, "effort"),
    systemPrompt: cloneSerializable(options.systemPrompt),
    tools: cloneSerializable(options.tools),
    settingSources: cloneSerializable(options.settingSources),
    maxTurns: options.maxTurns ?? null,
    thinking: projectedOption(options, "thinking"),
    includePartialMessages: options.includePartialMessages ?? null,
    outputFormat: projectedOption(options, "outputFormat"),
    env: {
      ...envProjection,
      strippedCredentialAbsence: Object.fromEntries(
        STRIPPED_ENV_NAMES.map((key) => [key, presence(env, key)]),
      ),
      transportCredentialStates: Object.fromEntries(
        TRANSPORT_CREDENTIAL_NAMES.map((key) => [key, presence(env, key)]),
      ),
      relevantStates: {
        [DISABLE_AUTO_MEMORY_ENV]: controlState(env),
        CLAUDE_CONFIG_DIR: presence(env, "CLAUDE_CONFIG_DIR"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: presence(
          env,
          "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        ),
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: presence(env, "CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
      },
      valuesSerialized: false,
    },
  };
}

function productionComparisonProjection(options) {
  const env = { ...(options.env ?? {}) };
  delete env[DISABLE_AUTO_MEMORY_ENV];
  return projectProductionOptions({ ...options, env });
}

async function* seamSuccess() {
  yield {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: "READY",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

async function captureProductionDispatch({ cwd, baseEnv }) {
  const dispatches = [];
  const caller = new SubscriptionSeatCaller(SPEC_SEAT, {
    budget: PROBE_BUDGET,
    cwd,
    env: baseEnv,
    startQuery(params) {
      dispatches.push(params);
      return seamSuccess();
    },
  });
  await caller.call(SEAT_REQUEST);
  if (dispatches.length !== 1) {
    throw new Error(`production seam dispatched ${dispatches.length} times; expected exactly 1`);
  }
  const dispatch = dispatches[0];
  if (typeof dispatch.prompt !== "string") {
    throw new Error("no-attachment production prompt unexpectedly used the streaming shape");
  }
  return dispatch;
}

function makeFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "t5-auto-memory-")));
  try {
    const workspace = join(root, "workspace");
    const autoMemoryDirectory = join(root, "auto-memory");
    const claudeConfigDirectory = join(root, "claude-config");
    mkdirSync(workspace);
    mkdirSync(autoMemoryDirectory);
    mkdirSync(claudeConfigDirectory);
    const canary = `T5_AUTO_MEMORY_CANARY_${randomBytes(16).toString("hex").toUpperCase()}`;
    const memoryFile = join(autoMemoryDirectory, "MEMORY.md");
    writeFileSync(
      memoryFile,
      [
        "# Scratch cross-run memory",
        "",
        "This file is probe-only state from an earlier run.",
        `Unique canary: ${canary}`,
        "",
      ].join("\n"),
      "utf8",
    );
    return { root, workspace, autoMemoryDirectory, claudeConfigDirectory, memoryFile, canary };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function sanitizeHeaders(headers) {
  return {
    names: Object.keys(headers).sort(),
    credentialHeaderStates: {
      authorization: presence(headers, "authorization"),
      "x-api-key": presence(headers, "x-api-key"),
    },
    valuesSerialized: false,
  };
}

function requestPath(url) {
  try {
    return new URL(String(url ?? ""), "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

async function startFakeAnthropic(onMessagesCaptured) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        request.destroy(new Error(`request exceeded ${MAX_REQUEST_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      let parseError = null;
      try {
        body = JSON.parse(raw);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      const isMessagesRequest = request.method === "POST" && requestPath(request.url) === "/v1/messages";
      const isHelloProbe = request.method === "HEAD" && request.url === "/api/hello";
      requests.push({
        method: request.method ?? null,
        target: request.url ?? null,
        kind: isMessagesRequest ? "messages" : isHelloProbe ? "hello-capability-probe" : "unexpected",
        host: request.headers.host ?? null,
        remoteAddress: request.socket.remoteAddress ?? null,
        headers: sanitizeHeaders(request.headers),
        body,
        invalidRawBody:
          parseError === null
            ? null
            : {
                present: raw.length > 0,
                byteLength: Buffer.byteLength(raw),
                serialized: false,
              },
        parseError,
      });
      if (isHelloProbe) {
        response.writeHead(200, { connection: "close" });
        response.end();
        return;
      }
      response.writeHead(400, {
        "content-type": "application/json",
        connection: "close",
      });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "T5_OFFLINE_CAPTURE_COMPLETE",
          },
        }),
      );
      if (isMessagesRequest) onMessagesCaptured();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("fake Anthropic server did not receive a TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function transportEnv(source, baseUrl) {
  const env = {};
  for (const key of PROBE_ENV_PASSTHROUGH_NAMES) {
    const value = source?.[key];
    if (typeof value === "string") env[key] = value;
  }
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_API_KEY = "t5-loopback-dummy-transport-key";
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_AUTO_UPDATE = "1";
  return env;
}

function makeSpawner({ fake, cli, stderr, childRef }) {
  return (spawnOptions) => {
    const env = transportEnv(spawnOptions.env, fake.baseUrl);
    cli.command = spawnOptions.command;
    cli.commandBasename = basename(spawnOptions.command);
    cli.argv = [...spawnOptions.args];
    cli.cwd = spawnOptions.cwd ?? null;
    cli.settingsArg = (() => {
      const index = spawnOptions.args.indexOf("--settings");
      return index === -1 ? null : spawnOptions.args[index + 1] ?? null;
    })();
    cli.spawnEnvironment = {
      ...keySetProjection(env),
      endpoint: {
        scheme: "http",
        hostname: "127.0.0.1",
        loopback: true,
      },
      transportCredentialStates: Object.fromEntries(
        TRANSPORT_CREDENTIAL_NAMES.map((key) => [
          key,
          key === "ANTHROPIC_API_KEY" ? "dummy-present" : presence(env, key),
        ]),
      ),
      endpointSelectorStates: Object.fromEntries(
        ENDPOINT_SELECTOR_NAMES.map((key) => [
          key,
          key === "ANTHROPIC_BASE_URL" ? "loopback-present" : presence(env, key),
        ]),
      ),
      proxyStates: Object.fromEntries(PROXY_NAMES.map((key) => [key, presence(env, key)])),
      nonessentialTrafficDisabled: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1",
      valuesSerialized: false,
    };

    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env,
      signal: spawnOptions.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    childRef.current = child;
    child.stderr?.on("data", (chunk) => {
      if (stderr.text.length < 8_000) stderr.text += String(chunk).slice(0, 8_000 - stderr.text.length);
    });
    return child;
  };
}

function findCanaryPaths(value, canary, path = "$", out = []) {
  if (typeof value === "string") {
    if (value.includes(canary)) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findCanaryPaths(item, canary, `${path}[${index}]`, out));
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      findCanaryPaths(item, canary, `${path}.${key}`, out);
    }
  }
  return out;
}

function isLoopbackRequest(request) {
  const host = String(request.host ?? "").split(":")[0];
  const remote = String(request.remoteAddress ?? "");
  return host === "127.0.0.1" && (remote === "127.0.0.1" || remote === "::ffff:127.0.0.1");
}

function isPromptBearingPath(path) {
  return /^requests\[\d+\]\.body\.(?:messages\[\d+\]\.content(?:\[\d+\]\.text)?|system(?:\[\d+\]\.text)?)$/.test(
    path,
  );
}

function productionContractChecks(dispatch, fixture) {
  const options = dispatch.options;
  return {
    promptExact: dispatch.prompt === SEAT_PROMPT,
    cwdIsScratchWorkspace: options.cwd === fixture.workspace,
    modelMatchesSeat: options.model === SPEC_SEAT.modelId,
    effortMatchesSeat: options.effort === SPEC_SEAT.effort,
    systemPromptExact: options.systemPrompt === SEAT_SYSTEM_PROMPT,
    toolsAreEmpty: Array.isArray(options.tools) && options.tools.length === 0,
    settingSourcesAreEmpty:
      Array.isArray(options.settingSources) && options.settingSources.length === 0,
    maxTurnsIsPositiveInteger: Number.isInteger(options.maxTurns) && options.maxTurns > 0,
    thinkingOptionAbsent: !Object.prototype.hasOwnProperty.call(options, "thinking"),
    partialMessagesDisabled: options.includePartialMessages === false,
    outputFormatAbsent: !Object.prototype.hasOwnProperty.call(options, "outputFormat"),
  };
}

async function runRealArm({ label, dispatch, fixture }) {
  const childRef = { current: null };
  const fake = await startFakeAnthropic(() => {
    // Stop AFTER the complete JSON body has been recorded. The API client's
    // built-in retry policy otherwise makes a second, redundant POST even for
    // the deterministic 400. SIGTERM is the bounded post-capture terminator;
    // no model response is needed for this request-assembly measurement.
    childRef.current?.kill("SIGTERM");
  });
  const cli = {};
  const stderr = { text: "" };
  const abortController = new AbortController();
  let timedOut = false;
  let sdkError = null;
  const messages = [];
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, HARD_TIMEOUT_MS);

  const settings = {
    autoMemoryEnabled: true,
    autoMemoryDirectory: fixture.autoMemoryDirectory,
  };
  const probeEnv = {
    ...(dispatch.options.env ?? {}),
    CLAUDE_CONFIG_DIR: fixture.claudeConfigDirectory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTO_UPDATE: "1",
  };
  const realQueryOptions = {
    ...dispatch.options,
    abortController,
    env: probeEnv,
    settings,
    spawnClaudeCodeProcess: makeSpawner({ fake, cli, stderr, childRef }),
  };
  const untouchedProductionFields = {
    cwd: realQueryOptions.cwd === dispatch.options.cwd,
    model: realQueryOptions.model === dispatch.options.model,
    effort: realQueryOptions.effort === dispatch.options.effort,
    systemPrompt: realQueryOptions.systemPrompt === dispatch.options.systemPrompt,
    tools: realQueryOptions.tools === dispatch.options.tools,
    settingSources: realQueryOptions.settingSources === dispatch.options.settingSources,
    maxTurns: realQueryOptions.maxTurns === dispatch.options.maxTurns,
    thinking: realQueryOptions.thinking === dispatch.options.thinking,
    includePartialMessages:
      realQueryOptions.includePartialMessages === dispatch.options.includePartialMessages,
    outputFormat: realQueryOptions.outputFormat === dispatch.options.outputFormat,
    prompt: dispatch.prompt === SEAT_PROMPT,
  };
  let session;
  try {
    session = query({
      prompt: dispatch.prompt,
      options: realQueryOptions,
    });
    for await (const message of session) {
      messages.push(`${message.type}${message.subtype ? `/${message.subtype}` : ""}`);
    }
  } catch (error) {
    sdkError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    abortController.abort();
    try {
      await session?.return?.(undefined);
    } catch {
      // The post-capture SIGTERM may already have terminated the child.
    }
    await fake.close();
  }

  const messageRequests = fake.requests.filter((request) => request.kind === "messages");
  const canaryPaths = fake.requests.flatMap((request, index) =>
    findCanaryPaths(request.body, fixture.canary).map(
      (path) => `requests[${index}].body${path.slice(1)}`,
    ),
  );
  const seatPromptPaths = fake.requests.flatMap((request, index) =>
    findCanaryPaths(request.body, SEAT_PROMPT).map(
      (path) => `requests[${index}].body${path.slice(1)}`,
    ),
  );
  const productionContract = productionContractChecks(dispatch, fixture);
  return {
    label,
    inputControlState: controlState(dispatch.options.env),
    prompt: dispatch.prompt,
    probeOnlyAugmentation: {
      settings,
      optionEnvAdditions: [
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "DISABLE_TELEMETRY",
        "DISABLE_AUTO_UPDATE",
      ],
      spawnWrapperChanges: {
        launchesSuppliedCommandAndArgvUnchanged: true,
        addsDummyTransportAuth: ["ANTHROPIC_API_KEY"],
        removesRealTransportAuth: TRANSPORT_CREDENTIAL_NAMES.filter(
          (key) => key !== "ANTHROPIC_API_KEY",
        ),
        forcesLoopbackEndpoint: ["ANTHROPIC_BASE_URL"],
        environmentPolicy: "fixed allowlist plus probe-owned transport values",
        inheritedNamesAllowed: PROBE_ENV_PASSTHROUGH_NAMES,
        removesOtherEndpointSelectors: "all omitted unless explicitly allowlisted",
        removesInheritedProxies: PROXY_NAMES,
        disablesNonessentialTraffic: true,
        valuesSerialized: false,
      },
      untouchedProductionFields,
      productionContract,
    },
    cli,
    capture: {
      requests: fake.requests,
      requestCount: fake.requests.length,
      messagesRequestCount: messageRequests.length,
      messagesBodiesParsed:
        messageRequests.length > 0 &&
        messageRequests.every(
          (request) =>
            request.parseError === null &&
            request.body !== null &&
            typeof request.body === "object" &&
            !Array.isArray(request.body),
        ),
      seatPromptPresent: seatPromptPaths.some(isPromptBearingPath),
      seatPromptPaths,
      everyRequestWasLoopback: fake.requests.length > 0 && fake.requests.every(isLoopbackRequest),
      onlyExpectedTargets:
        fake.requests.length > 0 &&
        fake.requests.every(
          (request) =>
            request.kind === "messages" || request.kind === "hello-capability-probe",
        ),
      canaryPresent: canaryPaths.length > 0,
      canaryPaths,
    },
    termination: {
      response: "deterministic HTTP 400 invalid_request_error T5_OFFLINE_CAPTURE_COMPLETE",
      timedOut,
      sdkEnvelopes: messages,
      sdkError,
      stderrExcerpt: stderr.text,
    },
  };
}

function checkArm(arm) {
  return {
    capturedExactlyOneMessagesRequest: arm.capture.messagesRequestCount === 1,
    messagesBodyParsed: arm.capture.messagesBodiesParsed,
    seatPromptPresentInMessagesBody: arm.capture.seatPromptPresent,
    capturedApiRequestsLoopbackOnly: arm.capture.everyRequestWasLoopback,
    onlyExpectedLoopbackTargets: arm.capture.onlyExpectedTargets,
    boundedTermination: !arm.termination.timedOut,
    realBundledCliLaunched:
      ["claude", "claude.exe"].includes(arm.cli.commandBasename) &&
      String(arm.cli.command ?? "").includes("claude-agent-sdk-") &&
      Array.isArray(arm.cli.argv),
    suppliedPromptUnchanged: arm.prompt === SEAT_PROMPT,
    productionFieldsUntouched: Object.values(
      arm.probeOnlyAugmentation.untouchedProductionFields,
    ).every(Boolean),
    productionSeatContractExact: Object.values(
      arm.probeOnlyAugmentation.productionContract,
    ).every(Boolean),
  };
}

function allTrue(record) {
  return Object.values(record).every(Boolean);
}

function derivedArmEvidenceIsValid(arm, canary, expectedCanaryPresent) {
  const requests = arm?.capture?.requests;
  if (!Array.isArray(requests)) return false;
  const isRecordedMessagesRequest = (request) =>
    request?.method === "POST" &&
    requestPath(request?.target) === "/v1/messages" &&
    request?.kind === "messages";
  const isRecordedHelloRequest = (request) =>
    request?.method === "HEAD" &&
    requestPath(request?.target) === "/api/hello" &&
    request?.kind === "hello-capability-probe";
  const messageRequests = requests.filter(isRecordedMessagesRequest);
  if (messageRequests.length !== 1) return false;
  const message = messageRequests[0];
  if (
    message?.parseError !== null ||
    message?.body === null ||
    typeof message?.body !== "object" ||
    Array.isArray(message?.body)
  ) {
    return false;
  }
  const promptPaths = requests.flatMap((request, index) =>
    findCanaryPaths(request?.body, SEAT_PROMPT).map(
      (path) => `requests[${index}].body${path.slice(1)}`,
    ),
  );
  const canaryPaths = requests.flatMap((request, index) =>
    findCanaryPaths(request?.body, canary).map(
      (path) => `requests[${index}].body${path.slice(1)}`,
    ),
  );
  const recordedPaths = arm?.capture?.canaryPaths;
  return (
    promptPaths.some(isPromptBearingPath) &&
    canaryPaths.every(isPromptBearingPath) &&
    (canaryPaths.length > 0) === expectedCanaryPresent &&
    arm?.capture?.canaryPresent === expectedCanaryPresent &&
    Array.isArray(recordedPaths) &&
    JSON.stringify([...recordedPaths].sort()) === JSON.stringify([...canaryPaths].sort()) &&
    requests.every(isLoopbackRequest) &&
    requests.every((request) => isRecordedMessagesRequest(request) || isRecordedHelloRequest(request))
  );
}

function isValidPreGuardEvidence(candidate) {
  const canary = candidate?.canary;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate.schemaVersion === undefined || [1, 2].includes(candidate.schemaVersion)) &&
    typeof canary === "string" &&
    /^T5_AUTO_MEMORY_CANARY_[A-F0-9]{32}$/.test(canary) &&
    candidate?.conclusion?.classification === "open-pre-guard" &&
    candidate?.arms?.default?.inputControlState === "absent" &&
    candidate?.arms?.disabled?.inputControlState === "1" &&
    derivedArmEvidenceIsValid(candidate.arms.default, canary, true) &&
    derivedArmEvidenceIsValid(candidate.arms.disabled, canary, false) &&
    candidate?.assertions?.defaultArm !== null &&
    typeof candidate?.assertions?.defaultArm === "object" &&
    allTrue(candidate.assertions.defaultArm) &&
    candidate?.assertions?.disabledArm !== null &&
    typeof candidate?.assertions?.disabledArm === "object" &&
    allTrue(candidate.assertions.disabledArm) &&
    candidate?.assertions?.acceptedObservation === true &&
    candidate?.productionCapture?.promptsByteIdentical === true &&
    candidate?.productionCapture?.optionsEqualExceptAutoMemoryControl === true
  );
}

function findValidPreGuardEvidence(candidate, depth = 0) {
  if (depth > 4 || candidate === null || typeof candidate !== "object") return null;
  if (isValidPreGuardEvidence(candidate)) return candidate;
  return findValidPreGuardEvidence(candidate.preGuardEvidence, depth + 1);
}

function projectPreGuardEvidence(candidate) {
  return {
    schemaVersion: candidate.schemaVersion ?? 1,
    measuredAt: candidate.measuredAt ?? null,
    versions: candidate.versions ?? null,
    canary: candidate.canary,
    productionCapture: candidate.productionCapture,
    arms: candidate.arms,
    assertions: candidate.assertions,
    conclusion: candidate.conclusion,
    negativeControl: candidate.negativeControl ?? null,
    note: "Validated historical wire evidence preserved from the pre-guard canonical result.",
  };
}

function loadPriorOpenEvidence() {
  if (!existsSync(RESULT_PATH)) return { evidence: null, status: "absent" };
  try {
    const prior = JSON.parse(readFileSync(RESULT_PATH, "utf8"));
    const candidate = findValidPreGuardEvidence(prior);
    return candidate === null
      ? { evidence: null, status: "present-but-invalid" }
      : { evidence: projectPreGuardEvidence(candidate), status: "validated" };
  } catch {
    return { evidence: null, status: "unparseable" };
  }
}

function validMutationObservation(record, probeSourceSha256) {
  const failedAssertions = Object.entries(record?.assertions ?? {})
    .filter(([, value]) => value === false)
    .map(([name]) => name);
  return (
    record?.probeSourceSha256 === probeSourceSha256 &&
    record?.mode === "mutated-disabled-control" &&
    record?.conclusion?.classification === "failure" &&
    record?.arms?.default?.inputControlState === "1" &&
    record?.arms?.disabled?.inputControlState === "absent" &&
    derivedArmEvidenceIsValid(record?.arms?.default, record?.canary, false) &&
    derivedArmEvidenceIsValid(record?.arms?.disabled, record?.canary, true) &&
    record?.assertions?.defaultArm !== null &&
    typeof record?.assertions?.defaultArm === "object" &&
    allTrue(record.assertions.defaultArm) &&
    record?.assertions?.disabledArm !== null &&
    typeof record?.assertions?.disabledArm === "object" &&
    allTrue(record.assertions.disabledArm) &&
    record?.assertions?.productionPromptsByteIdentical === true &&
    record?.assertions?.productionOptionsEqualExceptControl === true &&
    record?.assertions?.disabledProductionControlState === "1" &&
    record?.assertions?.disabledArmControlState === "absent" &&
    record?.assertions?.disabledControlWasSet === false &&
    record?.assertions?.disabledCanaryAbsent === false &&
    record?.assertions?.acceptedObservation === false &&
    record?.mutationIntegrity?.canonicalUnchanged === true &&
    failedAssertions.includes("disabledControlWasSet") &&
    failedAssertions.includes("disabledCanaryAbsent") &&
    failedAssertions.includes("acceptedObservation")
  );
}

function mutationObservation(record) {
  return {
    measuredAt: record.measuredAt,
    probeSourceSha256: record.probeSourceSha256,
    exitCode: 1,
    classification: record.conclusion.classification,
    defaultCanaryPresent: record.arms.default.capture.canaryPresent,
    disabledCanaryPresent: record.arms.disabled.capture.canaryPresent,
    disabledProductionControlState: record.assertions.disabledProductionControlState,
    disabledArmControlState: record.assertions.disabledArmControlState,
    failedAssertions: Object.entries(record.assertions)
      .filter(([, value]) => value === false)
      .map(([name]) => name),
    canonicalBeforeSha256: record.mutationIntegrity.canonicalBeforeSha256,
    canonicalAfterSha256: record.mutationIntegrity.canonicalAfterSha256,
    canonicalResultWritten: false,
    canonicalUnchanged: true,
  };
}

function loadNegativeControlObservation(probeSourceSha256, priorEvidence) {
  if (existsSync(MUTATION_RESULT_PATH)) {
    try {
      const mutation = JSON.parse(readFileSync(MUTATION_RESULT_PATH, "utf8"));
      if (validMutationObservation(mutation, probeSourceSha256)) return mutationObservation(mutation);
    } catch {
      // An invalid sidecar is ignored and retained for inspection.
    }
  }
  const prior = priorEvidence?.negativeControl?.observed;
  return prior?.probeSourceSha256 === probeSourceSha256 && prior?.canonicalUnchanged === true
    ? prior
    : null;
}

async function main(argv) {
  const mutateDisableControl = argv.includes("--mutate-disable-control");
  const unexpected = argv.filter((arg) => arg !== "--mutate-disable-control");
  if (unexpected.length > 0) throw new Error(`unknown argument(s): ${unexpected.join(", ")}`);

  const sdkPackage = JSON.parse(readFileSync(SDK_PACKAGE_PATH, "utf8"));
  const probeSourceSha256 = fileSha256(SOURCE_PATH);
  if (probeSourceSha256 === null) throw new Error("probe source could not be hashed");
  const priorEvidenceLoad = mutateDisableControl
    ? { evidence: null, status: "skipped-in-mutation" }
    : loadPriorOpenEvidence();
  const priorEvidence = priorEvidenceLoad.evidence;
  const negativeControlObservation = mutateDisableControl
    ? null
    : loadNegativeControlObservation(probeSourceSha256, priorEvidence);
  const canonicalHashAtStart = fileSha256(RESULT_PATH);
  const fixture = makeFixture();
  let result;

  try {
    const sharedBase = { ...process.env };
    delete sharedBase[DISABLE_AUTO_MEMORY_ENV];
    const defaultBase = { ...sharedBase };
    const disabledBase = { ...sharedBase };
    if (!mutateDisableControl) disabledBase[DISABLE_AUTO_MEMORY_ENV] = "1";

    const defaultDispatch = await captureProductionDispatch({
      cwd: fixture.workspace,
      baseEnv: defaultBase,
    });
    const disabledDispatch = await captureProductionDispatch({
      cwd: fixture.workspace,
      baseEnv: disabledBase,
    });
    const defaultProduction = projectProductionOptions(defaultDispatch.options);
    const disabledProduction = projectProductionOptions(disabledDispatch.options);
    let disabledQueryDispatch = disabledDispatch;
    if (mutateDisableControl) {
      // The production guard correctly re-adds the flag now. Remove ONLY this
      // one control from the real-query copy so the negative control stays red
      // and rerunnable without weakening production or touching the canonical
      // result. Prompt, cwd, tools, settingSources, and every other option remain
      // exactly as captured by the production seam.
      const mutatedEnv = { ...(disabledDispatch.options.env ?? {}) };
      delete mutatedEnv[DISABLE_AUTO_MEMORY_ENV];
      disabledQueryDispatch = {
        ...disabledDispatch,
        options: { ...disabledDispatch.options, env: mutatedEnv },
      };
    }
    const productionOptionsEqualExceptControl =
      JSON.stringify(productionComparisonProjection(defaultDispatch.options)) ===
      JSON.stringify(productionComparisonProjection(disabledDispatch.options));
    const productionPromptsByteIdentical = defaultDispatch.prompt === disabledDispatch.prompt;

    const defaultArm = await runRealArm({
      label: "default",
      dispatch: defaultDispatch,
      fixture,
    });
    const disabledArm = await runRealArm({
      label: mutateDisableControl ? "disabled-MUTATED-control-omitted" : "disabled",
      dispatch: disabledQueryDispatch,
      fixture,
    });

    const defaultChecks = checkArm(defaultArm);
    const disabledChecks = checkArm(disabledArm);
    const productionDefaultControlState = controlState(defaultDispatch.options.env);
    const productionDisabledControlState = controlState(disabledDispatch.options.env);
    const disabledArmControlState = controlState(disabledQueryDispatch.options.env);
    const expectedDisabledState = mutateDisableControl ? "1 (deliberately omitted: must fail)" : "1";
    const disabledControlWasSet = disabledArmControlState === "1";
    const apparatusPassed =
      allTrue(defaultChecks) &&
      allTrue(disabledChecks) &&
      productionOptionsEqualExceptControl &&
      productionPromptsByteIdentical &&
      disabledControlWasSet;

    let classification;
    let claim;
    let productionChangeDecision;
    if (!apparatusPassed) {
      classification = "failure";
      claim = "The apparatus or disabled control failed; no auto-memory conclusion is valid.";
      productionChangeDecision = "none-from-failed-measurement";
    } else if (defaultArm.capture.canaryPresent && !disabledArm.capture.canaryPresent) {
      classification = "open-pre-guard";
      claim =
        "The default sealed seat included cross-run auto memory; the explicit disable control removed it.";
      productionChangeDecision = "force CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 in seatCallEnv";
    } else if (!defaultArm.capture.canaryPresent && !disabledArm.capture.canaryPresent) {
      if (
        productionDefaultControlState === "1" &&
        priorEvidence !== null &&
        negativeControlObservation !== null
      ) {
        classification = "open-pre-guard-closed-post-guard";
        claim =
          "Pre-guard evidence showed the canary in the default request. After the production guard, " +
          "both rerun arms omitted it.";
        productionChangeDecision = "guard-added-and-verified";
      } else if (productionDefaultControlState !== "1") {
        classification = "closed-by-default";
        claim = "Neither arm included cross-run auto memory; no production change is needed.";
        productionChangeDecision = "no-production-change";
      } else if (priorEvidence === null) {
        classification = "failure";
        claim =
          "The production guard is active, but no structurally valid pre-guard wire evidence was available.";
        productionChangeDecision = "preserve-guard-and-recover-pre-guard-evidence";
      } else {
        classification = "failure";
        claim =
          "The production guard is active, but no source-bound current mutation observation was available.";
        productionChangeDecision = "preserve-guard-and-rerun-negative-control";
      }
    } else if (disabledArm.capture.canaryPresent) {
      classification = "failure";
      claim = "The canary survived the disabled control; no safe closed-channel claim is valid.";
      productionChangeDecision = "investigate-control-failure";
    } else {
      classification = "failure";
      claim = "The observed arm combination was not one of the accepted outcomes.";
      productionChangeDecision = "none-from-failed-measurement";
    }

    const actualCliCommand = defaultArm.cli.command;
    let actualCliVersionOutput = null;
    if (typeof actualCliCommand === "string") {
      actualCliVersionOutput = execFileSync(actualCliCommand, ["--version"], {
        encoding: "utf8",
        env: transportEnv(
          { ...process.env, CLAUDE_CONFIG_DIR: fixture.claudeConfigDirectory },
          "http://127.0.0.1:9",
        ),
        timeout: 5_000,
      }).trim();
    }

    const acceptedObservation =
      apparatusPassed &&
      ((defaultArm.capture.canaryPresent && !disabledArm.capture.canaryPresent) ||
        (!defaultArm.capture.canaryPresent &&
          !disabledArm.capture.canaryPresent &&
          (productionDefaultControlState !== "1" ||
            (priorEvidence !== null && negativeControlObservation !== null))));
    const assertions = {
      defaultArm: defaultChecks,
      disabledArm: disabledChecks,
      productionPromptsByteIdentical,
      productionOptionsEqualExceptControl,
      defaultInputExplicitlyRemovedInheritedDisableFlag:
        !Object.prototype.hasOwnProperty.call(defaultBase, DISABLE_AUTO_MEMORY_ENV),
      disabledInputControlExpected: expectedDisabledState,
      disabledProductionControlState: productionDisabledControlState,
      disabledArmControlState,
      disabledControlWasSet,
      credentialNamesStrippedBeforeProbeAugmentation: Object.values(
        defaultProduction.env.strippedCredentialAbsence,
      ).every((state) => state === "absent"),
      priorEvidenceStatus: priorEvidenceLoad.status,
      preGuardEvidenceValidWhenGuardActive:
        productionDefaultControlState !== "1" || priorEvidence !== null,
      sourceBoundNegativeControlValidWhenGuardActive:
        productionDefaultControlState !== "1" || negativeControlObservation !== null,
      preGuardDefaultCanaryPresent:
        priorEvidence === null ? "not-applicable" : priorEvidence.arms.default.capture.canaryPresent === true,
      postGuardDefaultCanaryAbsent:
        priorEvidence === null || productionDefaultControlState !== "1"
          ? "not-applicable"
          : !defaultArm.capture.canaryPresent,
      disabledCanaryAbsent: !disabledArm.capture.canaryPresent,
      acceptedObservation,
    };

    result = {
      schemaVersion: 2,
      probe: "T5 sealed-seat cross-run auto-memory wire canary",
      measuredAt: new Date().toISOString(),
      mode: mutateDisableControl ? "mutated-disabled-control" : "canonical",
      probeSourceSha256,
      versions: {
        claudeAgentSdk: sdkPackage.version ?? null,
        claudeCodeDeclaredBySdkPackage: sdkPackage.claudeCodeVersion ?? null,
        claudeCodeActualVersionOutput: actualCliVersionOutput,
      },
      exactQuestion: EXACT_QUESTION,
      canary: fixture.canary,
      fixture: {
        root: fixture.root,
        workspace: fixture.workspace,
        autoMemoryDirectory: fixture.autoMemoryDirectory,
        memoryFile: fixture.memoryFile,
        memoryLayout: "<scratchAutoMemoryDirectory>/MEMORY.md",
        claudeConfigDirectory: fixture.claudeConfigDirectory,
        cleanedAfterRun: false,
      },
      productionCapture: {
        seam: "SubscriptionSeatCaller startQuery",
        noAttachments: true,
        promptShape: "string",
        prompt: defaultDispatch.prompt,
        arms: {
          default: { prompt: defaultDispatch.prompt, options: defaultProduction },
          disabled: { prompt: disabledDispatch.prompt, options: disabledProduction },
        },
        promptsByteIdentical: productionPromptsByteIdentical,
        optionsEqualExceptAutoMemoryControl: productionOptionsEqualExceptControl,
        note:
          "This is the production projection before settings, config isolation, dummy auth, loopback URL, " +
          "or custom spawning were added. Environment names and values are represented only by counts, " +
          "digests, and an allowlisted set of relevant presence states.",
      },
      arms: { default: defaultArm, disabled: disabledArm },
      assertions,
      conclusion: { classification, claim },
      productionChangeDecision,
      preGuardEvidence: priorEvidence,
      negativeControl: {
        command: "node probes/auto-memory-canary.mjs --mutate-disable-control",
        mutation: `remove ${DISABLE_AUTO_MEMORY_ENV} from the disabled real-query arm after production capture`,
        canonicalResultWrittenByMutation: false,
        expectedRedAssertion: "disabledControlWasSet",
        observed: negativeControlObservation,
      },
      notes: [
        "The in-memory canary scan walks the entire parsed JSON object, including system and messages. " +
          "Persisted request bodies keep the prompt-bearing fields but redact transport metadata values.",
        "The loopback fake endpoint answers Claude Code's HEAD /api/hello capability probe locally, then " +
          "returns a deterministic HTTP 400 and terminates the child immediately after the first complete " +
          "/v1/messages body is captured. Retries, timeouts, missing captures, unexpected targets, or a " +
          "non-loopback socket observed by the fake endpoint are failures.",
        "Inline autoMemoryEnabled:true makes feature availability explicit. autoMemoryDirectory names the " +
          "directory itself, and MEMORY.md is seeded directly inside it.",
        "The spawn wrapper launches exactly the command and argv supplied by the SDK. Its child environment " +
          "is a fixed allowlist plus probe-owned dummy auth, loopback transport, and traffic-disable flags.",
        "The fake API response prevents a model response; this probe measures CLI request assembly only. " +
          "It does not claim to be an OS-level egress sandbox.",
      ],
    };

    process.stdout.write(
      `${JSON.stringify(
        {
          mode: result.mode,
          resultPath: mutateDisableControl
            ? MUTATION_RESULT_PATH
            : classification === "failure"
              ? FAILURE_RESULT_PATH
              : RESULT_PATH,
          classification,
          defaultCanaryPresent: defaultArm.capture.canaryPresent,
          disabledCanaryPresent: disabledArm.capture.canaryPresent,
          disabledProductionControlState: productionDisabledControlState,
          disabledArmControlState,
          failedAssertions: Object.entries(assertions)
            .filter(([, value]) => value === false)
            .map(([name]) => name),
        },
        null,
        2,
      )}\n`,
    );
    return classification === "failure" ? 1 : 0;
  } catch (error) {
    result = {
      schemaVersion: 2,
      probe: "T5 sealed-seat cross-run auto-memory wire canary",
      measuredAt: new Date().toISOString(),
      mode: mutateDisableControl ? "mutated-disabled-control" : "canonical",
      probeSourceSha256,
      versions: {
        claudeAgentSdk: sdkPackage.version ?? null,
        claudeCodeDeclaredBySdkPackage: sdkPackage.claudeCodeVersion ?? null,
        claudeCodeActualVersionOutput: null,
      },
      exactQuestion: EXACT_QUESTION,
      canary: fixture.canary,
      fixture: {
        root: fixture.root,
        workspace: fixture.workspace,
        autoMemoryDirectory: fixture.autoMemoryDirectory,
        memoryFile: fixture.memoryFile,
        memoryLayout: "<scratchAutoMemoryDirectory>/MEMORY.md",
        claudeConfigDirectory: fixture.claudeConfigDirectory,
        cleanedAfterRun: false,
      },
      productionCapture: null,
      arms: null,
      assertions: { completed: false },
      conclusion: {
        classification: "failure",
        claim: "The probe threw before it could produce an accepted measurement.",
      },
      productionChangeDecision: "none-from-failed-measurement",
      preGuardEvidence: priorEvidence,
      negativeControl: {
        command: "node probes/auto-memory-canary.mjs --mutate-disable-control",
        mutation: `remove ${DISABLE_AUTO_MEMORY_ENV} from the disabled real-query arm after production capture`,
        canonicalResultWrittenByMutation: false,
        expectedRedAssertion: "disabledControlWasSet",
        observed: negativeControlObservation,
      },
      error: error instanceof Error ? error.message : String(error),
      notes: [
        "This failure record was written from the probe's catch/finally path; it makes no memory claim.",
        `Prior pre-guard evidence status: ${priorEvidenceLoad.status}.`,
        "Environment names and values, transport metadata values, and absolute bundled-CLI paths are not serialized.",
      ],
    };
    process.stderr.write(`${error?.stack ?? error}\n`);
    return 1;
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    if (result?.fixture) result.fixture.cleanedAfterRun = true;
    if (result !== undefined && mutateDisableControl) {
      const canonicalAfterSha256 = fileSha256(RESULT_PATH);
      result.mutationIntegrity = {
        canonicalBeforeSha256: canonicalHashAtStart,
        canonicalAfterSha256,
        canonicalUnchanged: canonicalAfterSha256 === canonicalHashAtStart,
        canonicalResultWritten: false,
      };
      writeJsonAtomic(MUTATION_RESULT_PATH, result);
    } else if (result !== undefined && result.conclusion?.classification === "failure") {
      writeJsonAtomic(FAILURE_RESULT_PATH, result);
    } else if (result !== undefined) {
      writeJsonAtomic(RESULT_PATH, result);
      rmSync(FAILURE_RESULT_PATH, { force: true });
      rmSync(MUTATION_RESULT_PATH, { force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
