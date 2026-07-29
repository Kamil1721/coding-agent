/**
 * proxy.ts — the pre-call chokepoint.
 *
 * WHY A PROXY AND NOT A CALLBACK. The hard ceiling must be checked BEFORE each
 * API call, against the worst-case cost of the request about to be dispatched:
 * {@link PreCallDecision} needs `worstCaseNextCallUsd`, and
 * `ProviderAdapter.worstCaseCallCostUsd` needs that request's `max_tokens`.
 * Neither the Claude Agent SDK nor the Claude Code CLI exposes the pending
 * request. A check at turn boundaries is a check AFTER the previous call and
 * cannot see the next one's `max_tokens`, so the ceiling could be exceeded by
 * one arbitrarily expensive call — which is exactly the failure the frozen
 * contract warns about. Sitting on the wire is the only place the check is real.
 *
 * FOUR THINGS THIS BUYS THAT NOTHING ELSE DOES:
 *
 *  1. A GENUINE PRE-CALL GATE. Every request, including every SDK retry — a
 *     429/529 retry is a new API call and is billed as one, so it gets its own
 *     check.
 *
 *  2. RAW PER-VENDOR USAGE OFF THE WIRE. `normalizeUsage` requires the vendor's
 *     own payload. Aggregated SDK totals cannot distinguish `cache_read` from
 *     `cache_creation`, which is the measurement that decides config C.
 *
 *  3. THE CREDENTIAL NEVER ENTERS THE SANDBOX. The builder container gets a
 *     random per-run token and this proxy's address. The real key is read from
 *     the supervisor's environment by NAME and injected here. A builder that
 *     exfiltrates its whole environment exfiltrates nothing.
 *
 *  4. ONE HARNESS FOR EVERY CONFIGURATION. Held-constant variable 2. The
 *     builder always speaks the Anthropic Messages API to this proxy; the proxy
 *     routes each seat to its own vendor. That is what lets config B run an
 *     Anthropic orchestrator and a DeepSeek subagent inside ONE harness — and
 *     it is where the model-substitution assertion lives.
 *
 * NEVER LOGGED: request bodies, response bodies, headers, or any credential.
 * The proxy sees ticket text, workspace contents and model output. It persists
 * usage counts and redacted metadata only.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { BakeoffError } from "./contracts.js";
import type { ModelSeat, Provider } from "./contracts.js";
import {
  adapterFor,
  assertResponseModel,
  upstreamBaseUrlFor,
  wireFormatFor,
} from "./adapters.js";
import { callClassKey, type RunLedger } from "./ledger.js";

/* -------------------------------------------------------------------------
 * Routing
 * ---------------------------------------------------------------------- */

/**
 * One seat, plus the model names the builder is allowed to ask for that mean
 * "this seat".
 *
 * The builder is a Claude-shaped client: it asks for `claude-opus-...` for
 * orchestrator turns and `claude-sonnet-...` for subagent turns. Those names are
 * ALIASES FOR SEATS, not models. The proxy resolves the alias to a seat and
 * rewrites the outgoing `model` to `seat.modelId` verbatim, so the vendor is
 * never left to guess.
 *
 * That rewrite is not cosmetic. DeepSeek's Anthropic-format endpoint maps
 * `claude-sonnet*` to deepseek-v4-flash (doc 03 section 6.4), and config B is
 * only meaningful on deepseek-v4-pro (doc 03 section 3.4). Passing the alias
 * through would silently measure the wrong model.
 */
export interface ProxySeatRoute {
  readonly seat: ModelSeat;
  /**
   * Lowercase prefixes of model names that route here, e.g. ["claude-opus"].
   * `seat.modelId` always routes here and need not be listed.
   */
  readonly requestModelPrefixes: readonly string[];
}

export interface BudgetProxyOptions {
  readonly ledger: RunLedger;
  readonly routes: readonly ProxySeatRoute[];
  /** Per-run bearer token the sandbox must present. Generated, never persisted. */
  readonly authToken: string;
  /** Credential source. Read by NAME from the seat. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Bind address. Defaults to 127.0.0.1. Ignored when `socketPath` is set. */
  readonly host?: string;
  /** Bind port. 0 picks an ephemeral port. Ignored when `socketPath` is set. */
  readonly port?: number;
  /**
   * Listen on a UNIX DOMAIN SOCKET instead of TCP.
   *
   * This is how the sandbox stays on `--network none` — a network namespace
   * with no route to anywhere — while still reaching exactly one endpoint. The
   * socket is bind-mounted into the container; a filesystem path is not a
   * network route, so nothing else becomes reachable. TCP is kept for tests
   * and for a host-side operator, never for a sealed run.
   */
  readonly socketPath?: string;
  /**
   * `max_tokens` assumed when a request omits it. The Messages API requires
   * the field, so this is a belt-and-braces figure for the ceiling check only.
   */
  readonly defaultMaxOutputTokens?: number;
  /**
   * Upstream request timeout. A BOUNDARY on one HTTP call, not a judgement
   * about the agent: it bounds a hung socket, and a hung socket is not
   * progress. It is not, and must never become, a stuck-detector.
   */
  readonly upstreamTimeoutMs?: number;
}

/**
 * Response header stamped on every reply this proxy produces or forwards.
 *
 * The seal probe uses it to prove WHICH service the sandbox's only route
 * reaches. Without it the probe can only establish that something answered,
 * and "something answered" is not the property held-constant variable 3
 * requires: a stale relay, a port collision or a hijacked destination would all
 * satisfy it.
 */
export const PROXY_IDENTITY_HEADER = "x-bakeoff-proxy";

export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Deliberately pessimistic input-token estimator.
 *
 * Two characters per token, against a real-world English average nearer four.
 * The estimate feeds the CEILING CHECK ONLY; the bill is always taken from the
 * vendor's own usage payload afterwards. Over-estimating stops a run slightly
 * early, which is recoverable. Under-estimating lets the last call cross the
 * ceiling, which is not. The basis string is recorded on every pre-call event
 * so a kill that lands near a boundary can be audited.
 *
 * A `count_tokens` call per request would be exact, and is deliberately not
 * done: it doubles the request count and its own cost is not free.
 */
export const INPUT_ESTIMATOR_BASIS = "request-body-chars/2 (deliberate over-estimate)";

export function estimateInputTokens(requestBodyText: string): number {
  return Math.ceil(requestBodyText.length / 2);
}

/** A per-run proxy token. Random, never written to disk, redacted from logs. */
export function generateProxyAuthToken(): string {
  return `bkoff-${randomBytes(24).toString("base64url")}`;
}

/* -------------------------------------------------------------------------
 * SSE usage collection
 * ---------------------------------------------------------------------- */

interface CollectedUsage {
  readonly model: string | null;
  readonly usage: Record<string, unknown> | null;
}

/**
 * Extracts model and usage from an Anthropic-format SSE stream.
 *
 * THE DOUBLE-COUNTING TRAP: `message_start` carries the input and cache fields
 * plus a PARTIAL `output_tokens`; `message_delta` carries the CUMULATIVE
 * `output_tokens`. Summing them over-reports output — the most expensive token
 * class — on every streamed call. So: input and cache fields come from
 * `message_start`, output comes from the LAST `message_delta`, and nothing is
 * ever added together.
 */
export class SseUsageCollector {
  #buffer = "";
  #startUsage: Record<string, unknown> | null = null;
  #model: string | null = null;
  #lastDeltaUsage: Record<string, unknown> | null = null;

  push(chunk: string): void {
    this.#buffer += chunk;
    let boundary = this.#buffer.indexOf("\n\n");
    while (boundary !== -1) {
      this.#consumeEvent(this.#buffer.slice(0, boundary));
      this.#buffer = this.#buffer.slice(boundary + 2);
      boundary = this.#buffer.indexOf("\n\n");
    }
    // A pathological upstream that never emits a blank line would grow this
    // buffer without bound. Cap it: usage always arrives inside small frames.
    if (this.#buffer.length > 1_000_000) this.#buffer = this.#buffer.slice(-1_000);
  }

  #consumeEvent(frame: string): void {
    let dataText = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataText += line.slice(5).trim();
    }
    if (dataText.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      return;
    }
    const event = parsed as Record<string, unknown>;
    const type = event["type"];
    if (type === "message_start") {
      const message = event["message"] as Record<string, unknown> | undefined;
      if (message !== undefined) {
        const model = message["model"];
        if (typeof model === "string") this.#model = model;
        const usage = message["usage"];
        if (usage !== null && typeof usage === "object") {
          this.#startUsage = usage as Record<string, unknown>;
        }
      }
      return;
    }
    if (type === "message_delta") {
      const usage = event["usage"];
      if (usage !== null && typeof usage === "object") {
        this.#lastDeltaUsage = usage as Record<string, unknown>;
      }
    }
  }

  /**
   * The merged usage payload, in the vendor's own field names, for
   * `normalizeUsage`. Output is taken from the final delta and never summed.
   */
  result(): CollectedUsage {
    if (this.#startUsage === null) return { model: this.#model, usage: null };
    const merged: Record<string, unknown> = { ...this.#startUsage };
    const delta = this.#lastDeltaUsage;
    if (delta !== null) {
      if (delta["output_tokens"] !== undefined) merged["output_tokens"] = delta["output_tokens"];
      if (delta["output_tokens_details"] !== undefined) {
        merged["output_tokens_details"] = delta["output_tokens_details"];
      }
      // Some responses restate cache fields on the delta. message_start is
      // authoritative for the input side, so those are deliberately ignored.
    }
    return { model: this.#model, usage: merged };
  }
}

/* -------------------------------------------------------------------------
 * Headers
 * ---------------------------------------------------------------------- */

/** Hop-by-hop and content-negotiation headers that must not be forwarded. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "authorization",
  "x-api-key",
  // fetch() transparently decompresses, so an encoded response would be
  // forwarded decoded under a header claiming otherwise. Ask for identity.
  "accept-encoding",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  // Stripped for the same reason: the body reaching us is already decoded.
  "content-encoding",
]);

/**
 * How each vendor wants its credential presented.
 *
 * Anthropic uses `x-api-key`. Moonshot's and DeepSeek's Anthropic-format
 * endpoints are documented as drop-in targets for `ANTHROPIC_AUTH_TOKEN`,
 * which clients send as `Authorization: Bearer` (doc 03 section 6.4).
 */
function authHeadersFor(provider: Provider, credential: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return { "x-api-key": credential };
    case "moonshot":
    case "deepseek":
      return { authorization: `Bearer ${credential}` };
    case "openai":
      return { authorization: `Bearer ${credential}` };
    default:
      return { authorization: `Bearer ${credential}` };
  }
}

/* -------------------------------------------------------------------------
 * The proxy
 * ---------------------------------------------------------------------- */

export interface ProxyStats {
  readonly requests: number;
  readonly allowed: number;
  readonly denied: number;
  /** Calls that were spent upstream but could not be costed. */
  readonly uncosted: number;
  readonly unroutable: number;
}

export class BudgetProxy {
  readonly #options: BudgetProxyOptions;
  readonly #server: Server;
  readonly #credentials = new Map<string, string>();
  #url = "";
  #requests = 0;
  #allowed = 0;
  #denied = 0;
  #uncosted = 0;
  #unroutable = 0;

  private constructor(options: BudgetProxyOptions) {
    this.#options = options;
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch((error: unknown) => {
        // A handler that throws must not take the supervisor down and must not
        // leave the builder hanging: answer with a clean, non-leaking error.
        this.#fail(res, 502, "proxy_error", errorMessage(error));
      });
    });
  }

  /**
   * Start the proxy.
   *
   * Resolves every seat's credential BY NAME up front, so a missing key fails
   * before the sandbox starts rather than mid-run. Refuses any seat whose
   * endpoint does not speak the Anthropic Messages API: routing it would mean
   * a second wire format, which is a second harness (held-constant variable 2).
   */
  static async start(options: BudgetProxyOptions): Promise<BudgetProxy> {
    const proxy = new BudgetProxy(options);
    const env = options.env ?? process.env;

    for (const route of options.routes) {
      const { seat } = route;
      if (wireFormatFor(seat) !== "anthropic-messages") {
        throw new BakeoffError(
          "not_implemented",
          `not implemented: ${seat.provider} does not speak the Anthropic Messages API, so the ` +
            `${seat.role} seat (${seat.provider}/${seat.modelId}) cannot be driven by this harness`,
          "This is a second, independent blocker on top of any pricing gap. Translating wire " +
            "formats would put one configuration on a different harness from the others, which " +
            "held-constant variable 2 forbids. Either the vendor publishes an Anthropic-format " +
            "endpoint (Moonshot and DeepSeek both do) or the configuration cannot be compared.",
        );
      }
      const credential = env[seat.envKeyName];
      if (credential === undefined || credential.trim().length === 0) {
        throw new BakeoffError(
          "missing_credential",
          `${seat.envKeyName} is not set; required by the ${seat.role} seat ` +
            `(${seat.provider}/${seat.modelId})`,
          `Set ${seat.envKeyName} in the environment that launches the harness. The value is read ` +
            "here and injected into upstream requests; it is never written to disk and never " +
            "reaches the sandbox.",
        );
      }
      proxy.#credentials.set(seat.envKeyName, credential.trim());
    }

    const socketPath = options.socketPath;
    if (socketPath !== undefined) {
      rmSync(socketPath, { force: true });
      mkdirSync(dirname(socketPath), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        proxy.#server.once("error", reject);
        proxy.#server.listen(socketPath, () => {
          proxy.#server.removeListener("error", reject);
          resolve();
        });
      });
      proxy.#url = `unix:${socketPath}`;
      return proxy;
    }

    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    await new Promise<void>((resolve, reject) => {
      proxy.#server.once("error", reject);
      proxy.#server.listen(port, host, () => {
        proxy.#server.removeListener("error", reject);
        resolve();
      });
    });
    const address = proxy.#server.address() as AddressInfo | null;
    if (address === null) {
      throw new BakeoffError(
        "not_implemented",
        "not implemented: the budget proxy bound to a non-TCP address",
        "Bind the proxy to a TCP host and port, or pass socketPath for a sealed run.",
      );
    }
    proxy.#url = `http://${host}:${address.port}`;
    return proxy;
  }

  get url(): string {
    return this.#url;
  }

  get port(): number {
    const address = this.#server.address();
    return address === null || typeof address === "string" ? 0 : address.port;
  }

  stats(): ProxyStats {
    return {
      requests: this.#requests,
      allowed: this.#allowed,
      denied: this.#denied,
      uncosted: this.#uncosted,
      unroutable: this.#unroutable,
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
      this.#server.closeAllConnections();
    });
    const socketPath = this.#options.socketPath;
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
  }

  /* ---------------------------------------------------------------------
   * Request handling
   * ------------------------------------------------------------------ */

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.#requests += 1;
    const ledger = this.#options.ledger;

    if (!this.#authenticated(req)) {
      // Nothing but this run's sandbox may spend through this proxy.
      this.#fail(res, 401, "authentication_error", "invalid or missing proxy token");
      return;
    }

    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const bodyBuffer = await readBody(req);
    const bodyText = bodyBuffer.toString("utf8");

    // Token counting is free and is how a well-behaved client avoids overruns.
    // It is forwarded without a ceiling check because it cannot cost anything.
    if (path.endsWith("/count_tokens")) {
      const route = this.#routeFor(bodyText);
      if (route === null) {
        this.#unroutable += 1;
        this.#fail(res, 400, "invalid_request_error", "no seat routes this model");
        return;
      }
      await this.#forward(req, res, route, bodyText, { gated: false });
      return;
    }

    if (!path.includes("/messages")) {
      this.#fail(
        res,
        404,
        "not_found_error",
        `the bake-off proxy serves the Messages API only; ${path} is not proxied`,
      );
      return;
    }

    const route = this.#routeFor(bodyText);
    if (route === null) {
      this.#unroutable += 1;
      ledger.alert(
        "precall_denied",
        "unrouted",
        `a request named a model no seat serves`,
        "Every model the builder can ask for must map to a seat in the configuration under test. " +
          "An unrouted model means the harness told the builder about a model it is not measuring.",
      );
      this.#fail(
        res,
        400,
        "invalid_request_error",
        "this model is not part of the configuration under test",
      );
      return;
    }

    const parsed = safeParseObject(bodyText);
    const plannedMaxOutputTokens = readMaxTokens(parsed) ?? this.#defaultMaxOutputTokens();
    const decision = ledger.precall({
      seat: route.seat,
      plannedMaxOutputTokens,
      estimatedInputTokens: estimateInputTokens(bodyText),
      estimatorBasis: INPUT_ESTIMATOR_BASIS,
    });

    if (!decision.allowed) {
      this.#denied += 1;
      this.#fail(
        res,
        403,
        "bakeoff_budget_boundary",
        `run halted on a budget boundary (${decision.killReason ?? "unknown"}): ` +
          `spend $${decision.cumulativeCostUsd.toFixed(4)} against a ceiling of ` +
          `$${decision.ceilingUsd.toFixed(2)}, worst case for this call ` +
          `$${decision.worstCaseNextCallUsd.toFixed(4)}. This is a boundary, not a judgement ` +
          "about progress.",
      );
      return;
    }

    this.#allowed += 1;
    await this.#forward(req, res, route, bodyText, { gated: true });
  }

  #authenticated(req: IncomingMessage): boolean {
    const expected = this.#options.authToken;
    const apiKey = headerValue(req, "x-api-key");
    if (apiKey === expected) return true;
    const auth = headerValue(req, "authorization");
    if (auth !== null && auth.replace(/^Bearer\s+/i, "") === expected) return true;
    return false;
  }

  #defaultMaxOutputTokens(): number {
    return this.#options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  /** Resolve the seat a request's `model` names. Exact id first, then alias. */
  #routeFor(bodyText: string): ProxySeatRoute | null {
    const parsed = safeParseObject(bodyText);
    const model = parsed === null ? undefined : parsed["model"];
    if (typeof model !== "string") return null;
    const wanted = model.toLowerCase();
    for (const route of this.#options.routes) {
      if (wanted === route.seat.modelId.toLowerCase()) return route;
    }
    for (const route of this.#options.routes) {
      for (const prefix of route.requestModelPrefixes) {
        if (wanted.startsWith(prefix.toLowerCase())) return route;
      }
    }
    return null;
  }

  async #forward(
    req: IncomingMessage,
    res: ServerResponse,
    route: ProxySeatRoute,
    bodyText: string,
    options: { readonly gated: boolean },
  ): Promise<void> {
    const { seat } = route;
    const ledger = this.#options.ledger;
    const credential = this.#credentials.get(seat.envKeyName);
    if (credential === undefined) {
      ledger.kill("credential_failure", `no credential resolved for ${seat.envKeyName}`);
      this.#fail(res, 500, "authentication_error", "the harness holds no credential for this seat");
      return;
    }

    // The outgoing model is ALWAYS the seat's own id. See ProxySeatRoute.
    const outgoingBody = rewriteModel(bodyText, seat.modelId);
    const streamed = isStreaming(safeParseObject(outgoingBody));

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers["content-type"] = "application/json";
    headers["accept-encoding"] = "identity";
    Object.assign(headers, authHeadersFor(seat.provider, credential));

    const base = upstreamBaseUrlFor(seat).replace(/\/+$/, "");
    const suffix = (req.url ?? "/v1/messages").replace(/^\/+/, "");
    const target = `${base}/${suffix}`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => {
        controller.abort();
      },
      this.#options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    );

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method ?? "POST",
        headers,
        body: outgoingBody,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      const message = errorMessage(error);
      ledger.recordHarnessError(`upstream request to ${seat.provider} failed: ${message}`);
      this.#fail(res, 502, "api_error", `upstream request failed: ${message}`);
      return;
    }

    res.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
      res.setHeader(name, value);
    });
    res.setHeader(PROXY_IDENTITY_HEADER, "1");

    const collector = new SseUsageCollector();
    const chunks: Buffer[] = [];
    const decoder = new TextDecoder();

    try {
      const body = upstream.body;
      if (body !== null) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buffer = Buffer.from(value);
          res.write(buffer);
          if (streamed) {
            collector.push(decoder.decode(value, { stream: true }));
          } else {
            chunks.push(buffer);
          }
        }
      }
    } catch (error) {
      ledger.recordHarnessError(`upstream stream aborted: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
      res.end();
    }

    if (!options.gated) return;

    // Money has now been spent. Everything below records it; nothing below can
    // un-spend it, so a failure here is an accounting failure and is surfaced
    // as one rather than being swallowed.
    const { model, usage } = streamed
      ? collector.result()
      : readNonStreamingUsage(Buffer.concat(chunks).toString("utf8"));

    if (upstream.status >= 400) {
      ledger.recordHarnessError(
        `${seat.provider}/${seat.modelId} returned HTTP ${upstream.status} on a gated call`,
      );
      if (upstream.status === 401 || upstream.status === 403) {
        ledger.kill(
          "credential_failure",
          `${seat.provider} rejected the credential named by ${seat.envKeyName} (HTTP ${upstream.status})`,
        );
      }
      return;
    }

    const classKey = callClassKey(seat.provider, seat.modelId, seat.role);

    try {
      assertResponseModel(seat.modelId, model);
    } catch (error) {
      const message = errorMessage(error);
      ledger.alert(
        "model_substitution",
        classKey,
        message,
        "Do not score this run. Re-run only after the endpoint serves the model under test.",
      );
      ledger.recordHarnessError(message);
      ledger.kill("infrastructure_failure", message);
      return;
    }

    if (usage === null) {
      this.#uncosted += 1;
      const message =
        `${seat.provider}/${seat.modelId} returned no usage payload on a ${streamed ? "streamed" : "unary"} call`;
      ledger.alert(
        "usage_not_costed",
        classKey,
        message,
        "A call was billed upstream and could not be costed, so this run's total UNDER-reports " +
          "spend. Do not use its dollar figures. Extend the adapter for this vendor's response " +
          "shape and re-run.",
      );
      ledger.recordHarnessError(message);
      ledger.kill("infrastructure_failure", message);
      return;
    }

    try {
      const row = adapterFor(seat.provider).normalizeUsage(usage, seat, nowIso());
      ledger.recordUsage(row, { httpStatus: upstream.status, streamed });
    } catch (error) {
      this.#uncosted += 1;
      const message = errorMessage(error);
      ledger.alert(
        "usage_not_costed",
        classKey,
        message,
        "The vendor's usage shape was not recognised, so this call is spent but not costed. The " +
          "run's dollar total UNDER-reports the bill. Extend src/adapters.ts and re-run: the raw " +
          "token counts are recorded unchanged, so nothing has to be re-measured.",
      );
      ledger.recordHarnessError(message);
      ledger.kill("infrastructure_failure", message);
    }
  }

  #fail(res: ServerResponse, status: number, type: string, message: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader(PROXY_IDENTITY_HEADER, "1");
    res.end(JSON.stringify({ type: "error", error: { type, message } }));
  }
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof BakeoffError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readMaxTokens(body: Record<string, unknown> | null): number | null {
  if (body === null) return null;
  const value = body["max_tokens"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function isStreaming(body: Record<string, unknown> | null): boolean {
  return body !== null && body["stream"] === true;
}

/**
 * Rewrite the request's `model` to the seat's own id.
 *
 * Re-serialising the body would change its bytes, and byte stability before the
 * last cache breakpoint is what the prompt cache is keyed on (doc 04 section
 * 3.3). But `model` is a top-level request parameter, not part of the cached
 * prefix — the cache key is `tools + system + messages` and is per-model
 * anyway — so re-serialisation here cannot cost a hit that a changed model
 * would not have cost regardless.
 */
function rewriteModel(bodyText: string, modelId: string): string {
  const parsed = safeParseObject(bodyText);
  if (parsed === null) return bodyText;
  if (parsed["model"] === modelId) return bodyText;
  return JSON.stringify({ ...parsed, model: modelId });
}

/** Usage and model from a non-streamed Messages response. */
function readNonStreamingUsage(text: string): CollectedUsage {
  const body = safeParseObject(text);
  if (body === null) return { model: null, usage: null };
  const model = body["model"];
  const usage = body["usage"];
  return {
    model: typeof model === "string" ? model : null,
    usage: usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>) : null,
  };
}
