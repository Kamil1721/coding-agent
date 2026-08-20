/**
 * Isolated Context7 capability pilot for independent code review.
 *
 * This is deliberately not part of `SubscriptionSeatCaller`: that caller is
 * the sealed acceptance boundary and must keep `tools: []`. It is also not an
 * MCP grant for the builder. One host-owned capability set drives the prompt,
 * SDK options, hook policy and audit for this separate seat.
 */

import { createHash } from "node:crypto";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookCallbackMatcher,
  Options,
  PreToolUseHookInput,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { subscriptionSubprocessEnv } from "./subprocess-env.js";
import { isSupportedReviewVersionRange } from "./review-claims.js";

export const CONTEXT7_SERVER = "context7";
export const CONTEXT7_URL = "https://mcp.context7.com/mcp";
export const CONTEXT7_RESOLVE_TOOL = "mcp__context7__resolve-library-id";
export const CONTEXT7_QUERY_TOOL = "mcp__context7__query-docs";
export const CONTEXT7_TOOLS = [CONTEXT7_QUERY_TOOL, CONTEXT7_RESOLVE_TOOL] as const;
export const INDEPENDENT_REVIEW_SEAT = "independent_code_review";
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

export type McpApplicability = "suggested" | "required";
export type McpLifecycle =
  | "planned"
  | "granted"
  | "connected"
  | "attempted"
  | "succeeded"
  | "failed"
  | "denied"
  | "satisfied"
  | "unsatisfied";

export interface McpObligation {
  readonly applicability: McpApplicability;
  readonly server: string;
  readonly toolAllowlist: readonly string[];
  readonly purpose: string;
  readonly seatScope: readonly [typeof INDEPENDENT_REVIEW_SEAT];
  readonly successCondition: {
    readonly kind: "observation";
    readonly schemaId: "context7-review-evidence-v1";
    readonly outputPath: "evidence";
  };
}

export interface ExternalReviewClaim {
  readonly kind: "external";
  /** Stable host-generated id, rendered into the required Context7 query marker. */
  readonly id: string;
  readonly package: string;
  readonly versionOrRange: string | null;
  readonly queryPurpose: string;
}

export interface InternalReviewClaim {
  readonly kind: "internal";
  readonly id: string;
  readonly subject: string;
}

export type ReviewClaim = ExternalReviewClaim | InternalReviewClaim;

export interface ReviewScope {
  readonly projectId: string;
  readonly claims: readonly ReviewClaim[];
}

export interface ReviewCapabilitySet {
  readonly seat: typeof INDEPENDENT_REVIEW_SEAT;
  readonly applicability: "not_applicable" | McpApplicability;
  readonly obligations: readonly McpObligation[];
  readonly externalClaims: readonly ExternalReviewClaim[];
  readonly promptCapabilityText: string;
}

export interface McpLifecycleEvent {
  readonly seat: typeof INDEPENDENT_REVIEW_SEAT;
  readonly obligationHash: string;
  readonly claimId: string | null;
  readonly server: string;
  readonly tool: string | null;
  readonly state: McpLifecycle;
  readonly code: McpOutcomeCode | null;
  readonly producedArtefactHashes: readonly string[];
}

export type McpOutcomeCode =
  | "pilot_not_enabled"
  | "server_unavailable"
  | "tool_unavailable"
  | "tool_not_allowlisted"
  | "claim_not_routed"
  | "tool_error"
  | "session_error"
  | "bootstrap_protocol_error"
  | "missing_structured_output"
  | "invalid_structured_output"
  | "raw_evidence_in_output"
  | "required_evidence_missing"
  | "source_unavailable"
  | "source_incomplete"
  | "scope_unavailable";

export interface Context7EvidenceProjection {
  readonly claimId: string;
  readonly package: string;
  readonly versionOrRange: string | null;
  readonly queryPurpose: string;
  readonly success: boolean;
  readonly evidenceHash: string;
  readonly seat: typeof INDEPENDENT_REVIEW_SEAT;
}

export interface ReviewFinding {
  readonly claimId: string;
  readonly severity: "info" | "warning" | "error";
  readonly title: string;
  readonly detail: string;
}

export interface IndependentReviewVerdict {
  readonly verdict: "pass" | "fail";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  /** Claim ids for which the reviewer says its verdict relied on Context7. */
  readonly evidence: readonly { readonly claimId: string }[];
}

export type Context7ReviewStatus = "completed" | "capability_unavailable" | "unsatisfied" | "failed";

export interface Context7ReviewOutcome {
  readonly status: Context7ReviewStatus;
  readonly capabilityApplicability: ReviewCapabilitySet["applicability"];
  readonly verdict: IndependentReviewVerdict | null;
  readonly evidence: readonly Context7EvidenceProjection[];
  readonly lifecycle: readonly McpLifecycleEvent[];
  readonly code: McpOutcomeCode | null;
}

export interface CapabilityBootstrapDecision {
  readonly continueReview: boolean;
  readonly blockingCode: McpOutcomeCode | null;
  readonly lifecycle: readonly McpLifecycleEvent[];
}

export interface Context7ReviewRequest {
  readonly scope: ReviewScope;
  readonly source: string;
  readonly modelId: string;
  readonly effort?: Options["effort"];
  /** The run's cancellation boundary, forwarded into the SDK subprocess. */
  readonly signal?: AbortSignal;
}

export interface Context7ReviewSession extends AsyncIterable<SDKMessage> {
  close(): void;
}

export type Context7ReviewSessionFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Context7ReviewSession;

export interface Context7ReviewRunnerOptions {
  readonly cwd: string;
  /** The only project allowed to receive the Context7 grant in this pilot. */
  readonly optedInProjectId: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly startQuery?: Context7ReviewSessionFactory;
}

interface TrustedMcpServer {
  readonly url: string;
  readonly tools: Readonly<Record<string, { readonly readOnly: true }>>;
}

/** Host-owned. Neither ticket text nor model output can add a server or URL. */
const TRUSTED_MCP_REGISTRY: Readonly<Record<string, TrustedMcpServer>> = Object.freeze({
  [CONTEXT7_SERVER]: Object.freeze({
    url: CONTEXT7_URL,
    tools: Object.freeze({
      [CONTEXT7_QUERY_TOOL]: Object.freeze({ readOnly: true as const }),
      [CONTEXT7_RESOLVE_TOOL]: Object.freeze({ readOnly: true as const }),
    }),
  }),
});

const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "evidence"],
  properties: {
    verdict: { enum: ["pass", "fail"] },
    summary: { type: "string", maxLength: 2_000 },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claimId", "severity", "title", "detail"],
        properties: {
          claimId: { type: "string", maxLength: 128 },
          severity: { enum: ["info", "warning", "error"] },
          title: { type: "string", maxLength: 300 },
          detail: { type: "string", maxLength: 4_000 },
        },
      },
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claimId"],
        properties: { claimId: { type: "string", maxLength: 128 } },
      },
    },
  },
};

function context7Obligation(applicability: McpApplicability): McpObligation {
  return {
    applicability,
    server: CONTEXT7_SERVER,
    toolAllowlist: CONTEXT7_TOOLS,
    purpose:
      "Verify every routed external library, framework, SDK, configuration, version, or deprecation claim against current Context7 documentation.",
    seatScope: [INDEPENDENT_REVIEW_SEAT],
    successCondition: {
      kind: "observation",
      schemaId: "context7-review-evidence-v1",
      outputPath: "evidence",
    },
  };
}

function validateReviewScope(scope: ReviewScope): void {
  const ids = new Set<string>();
  for (const claim of scope.claims) {
    if (claim.id.trim().length === 0 || ids.has(claim.id)) throw new Error("review claim ids must be unique and non-empty");
    ids.add(claim.id);
    if (claim.kind === "external" && (claim.package.trim().length === 0 || claim.queryPurpose.trim().length === 0)) {
      throw new Error("external review claims need a package and query purpose");
    }
    if (claim.kind === "external" && claim.package !== claim.package.trim()) {
      throw new Error("external review package names cannot have leading or trailing whitespace");
    }
    if (claim.kind === "external") {
      const scopedPackage = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu.test(claim.package);
      if ((claim.package.startsWith("@") && !scopedPackage) || (!claim.package.startsWith("@") && claim.package.includes("/"))) {
        throw new Error("external review packages containing a slash must use @scope/name syntax");
      }
    }
    if (
      claim.kind === "external" &&
      claim.versionOrRange !== null &&
      !isSupportedReviewVersionRange(claim.versionOrRange)
    ) {
      throw new Error("external review versions must be exact semver, a major, a major/minor wildcard, or a ^/~ semver range");
    }
  }
}

function context7Query(claim: ExternalReviewClaim): string {
  return `[claim:${claim.id}] ${claim.package}@${claim.versionOrRange ?? "unspecified"}: ${claim.queryPurpose}`;
}

/** Production applicability compiler. External claims are always required. */
export function compileReviewCapabilitySet(scope: ReviewScope): ReviewCapabilitySet {
  validateReviewScope(scope);
  const externalClaims = scope.claims.filter((claim): claim is ExternalReviewClaim => claim.kind === "external");
  if (externalClaims.length === 0) {
    return {
      seat: INDEPENDENT_REVIEW_SEAT,
      applicability: "not_applicable",
      obligations: [],
      externalClaims: [],
      promptCapabilityText:
        "Context7 is not applicable: this scope contains only repository-internal logic, copy, layout, or conventions. Do not make external API or version claims.",
    };
  }
  const markers = externalClaims.map((claim) => `- ${context7Query(claim)}`);
  return {
    seat: INDEPENDENT_REVIEW_SEAT,
    applicability: "required",
    obligations: [context7Obligation("required")],
    externalClaims,
    promptCapabilityText: [
      "Context7 is required for every external claim below.",
      "First resolve each package, then call query-docs with the returned library id. Both tool queries must equal the full routed line below, including its [claim:<id>] marker. A verdict is rejected unless every claim has a successful query-docs result and appears in output.evidence.",
      ...markers,
    ].join("\n"),
  };
}

/** Test/control compiler for the generic suggested-unavailable lifecycle arm. */
export function compileSuggestedContext7Control(scope: ReviewScope): ReviewCapabilitySet {
  validateReviewScope(scope);
  const externalClaims = scope.claims.filter((claim): claim is ExternalReviewClaim => claim.kind === "external");
  return {
    seat: INDEPENDENT_REVIEW_SEAT,
    applicability: "suggested",
    obligations: [context7Obligation("suggested")],
    externalClaims,
    promptCapabilityText:
      "Context7 is suggested for this control run. Continue without it if bootstrap reports it unavailable.",
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function obligationHash(obligation: McpObligation): string {
  return sha256(obligation);
}

export function expectedContext7ObligationHashes(scope: ReviewScope): readonly string[] {
  return compileReviewCapabilitySet(scope).obligations.map(obligationHash);
}

function event(
  obligation: McpObligation,
  state: McpLifecycle,
  tool: string | null = null,
  code: McpOutcomeCode | null = null,
  producedArtefactHashes: readonly string[] = [],
  claimId: string | null = null,
): McpLifecycleEvent {
  return {
    seat: INDEPENDENT_REVIEW_SEAT,
    obligationHash: obligationHash(obligation),
    claimId,
    server: obligation.server,
    tool,
    state,
    code,
    producedArtefactHashes,
  };
}

function reviewPrompt(request: Context7ReviewRequest, capabilities: ReviewCapabilitySet): string {
  const claims = request.scope.claims.map((claim) =>
    claim.kind === "external"
      ? `[${claim.id}] external ${claim.package}@${claim.versionOrRange ?? "unspecified"}: ${claim.queryPurpose}`
      : `[${claim.id}] internal: ${claim.subject}`,
  );
  return [
    "Review only the supplied source against the declared scope. You have no workspace or shell access.",
    "Return the required JSON verdict. Do not introduce external claims that are absent from the scope.",
    "For each external claim, include its claimId in output.evidence only after successful Context7 query-docs evidence.",
    "",
    "CAPABILITY CONTRACT",
    capabilities.promptCapabilityText,
    "",
    "REVIEW SCOPE",
    ...claims,
    "",
    "SOURCE",
    request.source,
  ].join("\n");
}

interface CapabilityGate {
  readonly wait: Promise<boolean>;
  readonly resolve: (allowed: boolean) => void;
  readonly markSourceDelivered: () => void;
  readonly sourceDelivered: () => boolean;
}

function makeCapabilityGate(): CapabilityGate {
  let settled = false;
  let delivered = false;
  let release: (allowed: boolean) => void = () => undefined;
  const wait = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  return {
    wait,
    resolve(allowed) {
      if (settled) return;
      settled = true;
      release(allowed);
    },
    markSourceDelivered() {
      delivered = true;
    },
    sourceDelivered() {
      return delivered;
    },
  };
}

function userMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    shouldQuery: true,
  };
}

function requestAborted(request: Context7ReviewRequest): boolean {
  return request.signal?.aborted ?? false;
}

async function* gatedReviewInput(
  request: Context7ReviewRequest,
  capabilities: ReviewCapabilitySet,
  gate: CapabilityGate,
): AsyncIterable<SDKUserMessage> {
  // A harmless first message starts streaming mode so the SDK can emit init.
  // The source is neither rendered nor written to the child until the host has
  // validated the exact MCP inventory and opened this gate.
  if (requestAborted(request)) {
    gate.resolve(false);
    return;
  }
  yield userMessage("Capability bootstrap. Wait for the next user message before producing a verdict.");
  if (!(await gate.wait)) return;
  if (requestAborted(request)) {
    gate.resolve(false);
    return;
  }
  gate.markSourceDelivered();
  if (requestAborted(request)) return;
  yield userMessage(reviewPrompt(request, capabilities));
}

function exactQueryClaim(input: unknown, claims: readonly ExternalReviewClaim[]): ExternalReviewClaim | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const queryText = (input as Record<string, unknown>)["query"];
  if (typeof queryText !== "string") return null;
  return claims.find((claim) => queryText === context7Query(claim)) ?? null;
}

function hasExactKeys(input: unknown, expected: readonly string[]): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const actual = Object.keys(input as Record<string, unknown>).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function resolvedPackage(input: unknown, claim: ExternalReviewClaim | null): boolean {
  if (!hasExactKeys(input, ["libraryName", "query"])) return false;
  const name = (input as Record<string, unknown>)["libraryName"];
  return claim !== null && name === claim.package;
}

function requestedLibraryId(input: unknown): string | null {
  if (!hasExactKeys(input, ["libraryId", "query"])) return null;
  const id = (input as Record<string, unknown>)["libraryId"];
  return typeof id === "string" ? id : null;
}

function rawTextParts(value: unknown, depth = 0): readonly string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim().length === 0 ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => rawTextParts(item, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  // Context7 is a text-producing MCP. Ignore envelope metadata such as
  // `{type: "text"}` so an empty text block can never count as evidence.
  if ("content" in record) return rawTextParts(record["content"], depth + 1);
  if (record["type"] === "text" && "text" in record) return rawTextParts(record["text"], depth + 1);
  if ("text" in record) return rawTextParts(record["text"], depth + 1);
  return [];
}

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: string | null;
  readonly normalized: string;
}

const EXACT_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/iu;
const WILDCARD_VERSION = /^v?(\d+)(?:\.(\d+))?\.(?:x|\*)$/iu;

function parseVersion(value: string): ParsedVersion | null {
  const matched = EXACT_VERSION.exec(value.trim());
  if (matched?.[1] === undefined || matched[2] === undefined || matched[3] === undefined) return null;
  const prerelease = matched[4] ?? null;
  const core = [Number(matched[1]), Number(matched[2]), Number(matched[3])] as const;
  return {
    core,
    prerelease,
    normalized: `${String(core[0])}.${String(core[1])}.${String(core[2])}${prerelease === null ? "" : `-${prerelease}`}`,
  };
}

function versionAtLeast(candidate: readonly [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const left = candidate[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function versionMatches(version: string, requested: string): boolean {
  const candidate = parseVersion(version);
  const range = requested.trim();
  if (candidate === null || range.length === 0) return false;
  const exact = parseVersion(range);
  if (exact !== null) return candidate.normalized === exact.normalized;
  // Broad ranges bind only to stable resolver entries. A caller that needs a
  // prerelease must request that exact prerelease.
  if (candidate.prerelease !== null) return false;
  const wildcard = WILDCARD_VERSION.exec(range);
  if (wildcard?.[1] !== undefined) {
    return candidate.core[0] === Number(wildcard[1]) &&
      (wildcard[2] === undefined || candidate.core[1] === Number(wildcard[2]));
  }
  if (/^v?\d+$/u.test(range)) return candidate.core[0] === Number(range.replace(/^v/u, ""));
  const requestedVersion = parseVersion(range.slice(1));
  if (requestedVersion === null) return false;
  if (range.startsWith("^")) {
    const [major, minor, patch] = requestedVersion.core;
    const sameCompatibilityBand = major > 0
      ? candidate.core[0] === major
      : minor > 0
        ? candidate.core[0] === 0 && candidate.core[1] === minor
        : candidate.core[0] === 0 && candidate.core[1] === 0 && candidate.core[2] === patch;
    return sameCompatibilityBand && versionAtLeast(candidate.core, requestedVersion.core);
  }
  if (range.startsWith("~")) {
    return (
      candidate.core[0] === requestedVersion.core[0] &&
      candidate.core[1] === requestedVersion.core[1] &&
      versionAtLeast(candidate.core, requestedVersion.core)
    );
  }
  return false;
}

/** Pilot registry: resolver prose can select a version, never an identity. */
const CONTEXT7_BASE_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  next: ["/vercel/next.js"],
  "next.js": ["/vercel/next.js"],
  react: ["/facebook/react"],
  "react-dom": ["/facebook/react"],
  "@playwright/test": ["/microsoft/playwright"],
  tailwindcss: ["/tailwindlabs/tailwindcss"],
  "@anthropic-ai/claude-agent-sdk": ["/websites/code_claude_en_agent-sdk"],
  "@openai/codex-sdk": ["/openai/codex"],
  swr: ["/vercel/swr"],
  "@xyflow/react": ["/xyflow/xyflow"],
  "lucide-react": ["/lucide-icons/lucide"],
  motion: ["/websites/motion_dev_react"],
  "framer-motion": ["/websites/motion_dev_react"],
  vite: ["/vitejs/vite"],
});

export function isCanonicalContext7Package(packageName: string): boolean {
  const ids = CONTEXT7_BASE_IDS[packageName.toLocaleLowerCase()];
  return ids !== undefined && ids.length === 1;
}

function resolvedLibraryIds(raw: unknown, claim: ExternalReviewClaim): readonly string[] {
  const admittedBaseIds = CONTEXT7_BASE_IDS[claim.package.toLocaleLowerCase()];
  if (admittedBaseIds === undefined || admittedBaseIds.length !== 1) return [];
  const text = rawTextParts(raw).join("\n");
  const candidates = text.split(/\n-{5,}\n/gu);
  const matches: { readonly ids: readonly string[]; readonly reputation: number; readonly benchmark: number }[] = [];
  for (const candidate of candidates) {
    const baseId = /Context7-compatible library ID:\s*(\/[a-z0-9_.-]+\/[a-z0-9_.-]+)/iu.exec(candidate)?.[1];
    if (baseId === undefined || baseId !== admittedBaseIds[0]) continue;
    const reputationName = /^-?\s*Source Reputation:\s*(.+)$/imu.exec(candidate)?.[1]?.trim().toLocaleLowerCase();
    const reputation = reputationName === "high" ? 3 : reputationName === "medium" ? 2 : reputationName === "low" ? 1 : 0;
    const benchmark = Number(/^-?\s*Benchmark Score:\s*([\d.]+)$/imu.exec(candidate)?.[1] ?? 0);
    if (claim.versionOrRange === null) {
      matches.push({ ids: [baseId], reputation, benchmark });
      continue;
    }
    const versions = /^-?\s*Versions:\s*(.+)$/imu.exec(candidate)?.[1]?.split(",") ?? [];
    const ids: string[] = [];
    for (const listed of versions) {
      const version = listed.trim().split("/").at(-1);
      if (version !== undefined && versionMatches(version, claim.versionOrRange)) ids.push(`${baseId}/${version}`);
    }
    if (ids.length > 0) matches.push({ ids, reputation, benchmark });
  }
  matches.sort((left, right) => right.reputation - left.reputation || right.benchmark - left.benchmark);
  return matches[0]?.ids ?? [];
}

interface Attempt {
  readonly tool: string;
  readonly claim: ExternalReviewClaim | null;
}

function makeCapabilityHook(
  capabilities: ReviewCapabilitySet,
  lifecycle: McpLifecycleEvent[],
  attempts: Map<string, Attempt>,
  resolvedIdsByClaim: ReadonlyMap<string, ReadonlySet<string>>,
): HookCallbackMatcher {
  const obligation = capabilities.obligations[0];
  const allowlist = new Set(obligation?.toolAllowlist ?? []);
  return {
    hooks: [
      async (raw, toolUseId) => {
        const input = raw as PreToolUseHookInput;
        const tool = input.tool_name;
        // `outputFormat: json_schema` is implemented by the SDK as this
        // host-owned finalization tool. It is not MCP and dispatches no external
        // capability; the parsed result is still checked below before admission.
        if (tool === STRUCTURED_OUTPUT_TOOL) {
          attempts.set(toolUseId ?? input.tool_use_id, { tool, claim: null });
          return { continue: true };
        }
        const claim = exactQueryClaim(input.tool_input, capabilities.externalClaims);
        if (obligation === undefined || !allowlist.has(tool)) {
          if (obligation !== undefined) {
            lifecycle.push(event(obligation, "denied", tool, "tool_not_allowlisted", [], claim?.id ?? null));
          }
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "This review seat permits only its exact read-only Context7 capability set.",
            },
          };
        }
        const libraryId = requestedLibraryId(input.tool_input);
        const valid =
          tool === CONTEXT7_QUERY_TOOL
            ? claim !== null && libraryId !== null && resolvedIdsByClaim.get(claim.id)?.has(libraryId) === true
            : tool === CONTEXT7_RESOLVE_TOOL && resolvedPackage(input.tool_input, claim);
        if (!valid) {
          lifecycle.push(event(obligation, "denied", tool, "claim_not_routed", [], claim?.id ?? null));
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                "Context7 calls must equal the routed query exactly; query-docs must use an id returned by its routed resolver call.",
            },
          };
        }
        attempts.set(toolUseId ?? input.tool_use_id, { tool, claim });
        lifecycle.push(event(obligation, "attempted", tool, null, [], claim?.id ?? null));
        return { continue: true };
      },
    ],
  };
}

function composeOptions(
  request: Context7ReviewRequest,
  capabilities: ReviewCapabilitySet,
  env: NodeJS.ProcessEnv,
  cwd: string,
  hook: HookCallbackMatcher,
  abortController: AbortController,
): Options {
  const obligations = capabilities.obligations;
  const toolAllowlist = obligations.flatMap((obligation) => [...obligation.toolAllowlist]);
  const servers: NonNullable<Options["mcpServers"]> = {};
  const allowedMcpServers: { serverName: string }[] = [];
  for (const obligation of obligations) {
    const trusted = TRUSTED_MCP_REGISTRY[obligation.server];
    if (trusted === undefined) throw new Error(`untrusted MCP server: ${obligation.server}`);
    for (const tool of obligation.toolAllowlist) {
      if (trusted.tools[tool]?.readOnly !== true) throw new Error(`untrusted or mutating MCP tool: ${tool}`);
    }
    servers[obligation.server] = { type: "http", url: trusted.url, alwaysLoad: true };
    allowedMcpServers.push({ serverName: obligation.server });
  }
  const childEnv = subscriptionSubprocessEnv(env);
  delete childEnv["CONTEXT7_API_KEY"];
  return {
    cwd,
    abortController,
    persistSession: false,
    model: request.modelId,
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    systemPrompt:
      "You are an isolated independent code-review seat. Review only the supplied text. Never claim that a capability was used unless its evidence appears in your structured output.",
    // Every external claim needs a routed resolve call and a query-docs call,
    // plus room to synthesize the structured verdict. A fixed eight-turn cap
    // made a normal framework manifest structurally unable to satisfy its own
    // mandatory evidence contract. The upper bound still prevents an extreme
    // manifest from turning one review into an unbounded session.
    maxTurns:
      capabilities.applicability === "not_applicable"
        ? 1
        : Math.min(32, Math.max(8, capabilities.externalClaims.length * 3 + 2)),
    permissionMode: "dontAsk",
    tools: toolAllowlist,
    allowedTools: toolAllowlist,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: servers,
    hooks: { PreToolUse: [hook] },
    managedSettings: {
      disableClaudeAiConnectors: true,
      allowedMcpServers,
      allowManagedMcpServersOnly: true,
      allowManagedHooksOnly: true,
    },
    outputFormat: { type: "json_schema", schema: REVIEW_OUTPUT_SCHEMA },
    env: childEnv,
  };
}

function unavailableCode(init: SDKMessage, obligation: McpObligation): McpOutcomeCode | null {
  if (init.type !== "system" || init.subtype !== "init") return "bootstrap_protocol_error";
  const server = init.mcp_servers.find((candidate) => candidate.name === obligation.server);
  if (server?.status !== "connected") return "server_unavailable";
  return obligation.toolAllowlist.every((tool) => init.tools.includes(tool)) ? null : "tool_unavailable";
}

export function evaluateCapabilityBootstrap(
  capabilities: ReviewCapabilitySet,
  init: SDKMessage,
): CapabilityBootstrapDecision {
  const lifecycle: McpLifecycleEvent[] = [];
  if (init.type !== "system" || init.subtype !== "init") {
    return { continueReview: false, blockingCode: "bootstrap_protocol_error", lifecycle };
  }
  const expectedServers = new Set(capabilities.obligations.map((obligation) => obligation.server));
  const expectedTools = new Set(capabilities.obligations.flatMap((obligation) => [...obligation.toolAllowlist]));
  const unexpectedServer = init.mcp_servers.some((server) => !expectedServers.has(server.name));
  const unexpectedTool = init.tools.some((tool) => tool.startsWith("mcp__") && !expectedTools.has(tool));
  if (unexpectedServer || unexpectedTool) {
    for (const obligation of capabilities.obligations) {
      lifecycle.push(event(obligation, "unsatisfied", null, "bootstrap_protocol_error"));
    }
    return { continueReview: false, blockingCode: "bootstrap_protocol_error", lifecycle };
  }
  let blockingCode: McpOutcomeCode | null = null;
  for (const obligation of capabilities.obligations) {
    const code = unavailableCode(init, obligation);
    if (code === null) lifecycle.push(event(obligation, "connected"));
    else {
      lifecycle.push(event(obligation, "unsatisfied", null, code));
      if (obligation.applicability === "required") blockingCode = code;
    }
  }
  return { continueReview: blockingCode === null, blockingCode, lifecycle };
}

type ParsedToolResult =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "one"; readonly id: string; readonly failed: boolean; readonly raw: unknown };

function toolResult(message: SDKMessage): ParsedToolResult {
  if (message.type !== "user" || !Array.isArray(message.message.content)) return { kind: "none" };
  const blocks = message.message.content.filter(
    (block) => typeof block === "object" && block !== null && "type" in block && block.type === "tool_result",
  );
  // The shipped SDK emits one normalized tool-result block per user frame.
  // A multi-block frame cannot be paired safely with its single
  // `tool_use_result` projection, so fail closed instead of guessing.
  if (blocks.length > 1) return { kind: "ambiguous" };
  const block = blocks[0];
  if (block === undefined) return { kind: "none" };
  const shaped = block as { tool_use_id?: unknown; is_error?: unknown; content?: unknown };
  if (typeof shaped.tool_use_id !== "string") return { kind: "ambiguous" };
  return {
    kind: "one",
    id: shaped.tool_use_id,
    failed: shaped.is_error === true,
    raw: (message as { tool_use_result?: unknown }).tool_use_result ?? shaped.content,
  };
}

function parseVerdict(
  value: unknown,
  findingClaimIds: ReadonlySet<string>,
  evidenceClaimIds: ReadonlySet<string>,
): IndependentReviewVerdict | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const shaped = value as Record<string, unknown>;
  if (shaped["verdict"] !== "pass" && shaped["verdict"] !== "fail") return null;
  if (typeof shaped["summary"] !== "string" || shaped["summary"].length > 2_000 || !Array.isArray(shaped["findings"]) || !Array.isArray(shaped["evidence"])) {
    return null;
  }
  const findings: ReviewFinding[] = [];
  for (const item of shaped["findings"]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const finding = item as Record<string, unknown>;
    if (
      typeof finding["claimId"] !== "string" ||
      !findingClaimIds.has(finding["claimId"]) ||
      (finding["severity"] !== "info" && finding["severity"] !== "warning" && finding["severity"] !== "error") ||
      typeof finding["title"] !== "string" ||
      typeof finding["detail"] !== "string" || finding["title"].length > 300 || finding["detail"].length > 4_000
    ) {
      return null;
    }
    findings.push({
      claimId: finding["claimId"],
      severity: finding["severity"],
      title: finding["title"],
      detail: finding["detail"],
    });
  }
  const evidence: { claimId: string }[] = [];
  const seenEvidenceClaimIds = new Set<string>();
  for (const item of shaped["evidence"]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const claimId = (item as Record<string, unknown>)["claimId"];
    if (
      typeof claimId !== "string" ||
      !evidenceClaimIds.has(claimId) ||
      seenEvidenceClaimIds.has(claimId)
    ) {
      return null;
    }
    seenEvidenceClaimIds.add(claimId);
    evidence.push({ claimId });
  }
  return { verdict: shaped["verdict"], summary: shaped["summary"], findings, evidence };
}

function normaliseEvidenceText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function verdictStrings(verdict: IndependentReviewVerdict): readonly string[] {
  return [
    verdict.summary,
    ...verdict.findings.flatMap((finding) => [finding.title, finding.detail]),
  ];
}

function copiesRawEvidence(verdict: IndependentReviewVerdict, rawParts: readonly string[]): boolean {
  const raw = rawParts.map(normaliseEvidenceText).filter((part) => part.length > 0);
  for (const value of verdictStrings(verdict).map(normaliseEvidenceText)) {
    for (const source of raw) {
      if (value === source) return true;
      if (value.includes(source)) return true;
      // A 24-character normalized run is long enough to catch meaningful
      // copied prose while allowing ordinary API names and short phrases.
      for (let offset = 0; offset + 24 <= source.length; offset += 1) {
        if (value.includes(source.slice(offset, offset + 24))) return true;
      }
    }
  }
  return false;
}

function resultStructuredOutput(message: SDKMessage): unknown | undefined {
  return message.type === "result" && message.subtype === "success" ? message.structured_output : undefined;
}

function makeOutcome(
  status: Context7ReviewStatus,
  capabilities: ReviewCapabilitySet,
  lifecycle: readonly McpLifecycleEvent[],
  code: McpOutcomeCode | null,
  verdict: IndependentReviewVerdict | null = null,
  evidence: readonly Context7EvidenceProjection[] = [],
): Context7ReviewOutcome {
  return {
    status,
    capabilityApplicability: capabilities.applicability,
    verdict,
    evidence,
    lifecycle,
    code,
  };
}

/**
 * Record a review invocation that failed before its runner could return an
 * outcome. External scopes retain their obligation identity without claiming
 * that MCP configuration or connection succeeded; internal scopes have no
 * capability lifecycle to record.
 */
export function context7SessionFailureOutcome(scope: ReviewScope): Context7ReviewOutcome {
  const capabilities = compileReviewCapabilitySet(scope);
  const lifecycle = capabilities.obligations.map((obligation) => event(obligation, "planned"));
  for (const obligation of capabilities.obligations) {
    lifecycle.push(event(obligation, "failed", null, "session_error"));
  }
  return makeOutcome("failed", capabilities, lifecycle, "session_error");
}

export class Context7ReviewRunner {
  readonly #cwd: string;
  readonly #optedInProjectId: string | null;
  readonly #env: NodeJS.ProcessEnv;
  readonly #startQuery: Context7ReviewSessionFactory;

  constructor(options: Context7ReviewRunnerOptions) {
    this.#cwd = options.cwd;
    this.#optedInProjectId = options.optedInProjectId;
    this.#env = options.env ?? process.env;
    this.#startQuery = options.startQuery ?? ((params) => query(params) as Query);
  }

  async review(request: Context7ReviewRequest): Promise<Context7ReviewOutcome> {
    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(request.signal?.reason);
    if (request.signal?.aborted === true) forwardAbort();
    else request.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      return await this.#review(request, abortController);
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async #review(request: Context7ReviewRequest, abortController: AbortController): Promise<Context7ReviewOutcome> {
    const capabilities = compileReviewCapabilitySet(request.scope);
    const lifecycle = capabilities.obligations.map((obligation) => event(obligation, "planned"));
    const required = capabilities.obligations.some((obligation) => obligation.applicability === "required");
    if (required && request.scope.projectId !== this.#optedInProjectId) {
      for (const obligation of capabilities.obligations) {
        lifecycle.push(event(obligation, "unsatisfied", null, "pilot_not_enabled"));
      }
      return makeOutcome("capability_unavailable", capabilities, lifecycle, "pilot_not_enabled");
    }

    const attempts = new Map<string, Attempt>();
    const settledAttemptIds = new Set<string>();
    const successfulEvidence = new Map<string, Context7EvidenceProjection>();
    const admittedRawText: string[] = [];
    const resolvedIdsByClaim = new Map<string, Set<string>>();
    const hook = makeCapabilityHook(capabilities, lifecycle, attempts, resolvedIdsByClaim);
    let options: Options;
    try {
      options = composeOptions(request, capabilities, this.#env, this.#cwd, hook, abortController);
    } catch {
      for (const obligation of capabilities.obligations) {
        lifecycle.push(event(obligation, "unsatisfied", null, "tool_unavailable"));
      }
      return makeOutcome("capability_unavailable", capabilities, lifecycle, "tool_unavailable");
    }
    for (const obligation of capabilities.obligations) lifecycle.push(event(obligation, "granted"));

    // Live SDK probe, 2026-08-20: a `shouldQuery: false` bootstrap terminates
    // without accepting later input. Streaming a harmless querying message
    // instead yields init while the second, source-bearing message remains
    // parked on this host-owned gate.
    const capabilityGate = makeCapabilityGate();
    let session: Context7ReviewSession;
    try {
      session = this.#startQuery({ prompt: gatedReviewInput(request, capabilities, capabilityGate), options });
    } catch {
      capabilityGate.resolve(false);
      for (const obligation of capabilities.obligations) {
        lifecycle.push(event(obligation, "failed", null, "session_error"));
      }
      return makeOutcome("failed", capabilities, lifecycle, "session_error");
    }
    let initSeen = false;
    let verdict: IndependentReviewVerdict | null = null;
    let terminalCode: McpOutcomeCode | null = null;
    let sessionFailed = false;
    try {
      for await (const message of session) {
        if (!initSeen) {
          initSeen = true;
          if (message.type !== "system" || message.subtype !== "init") {
            capabilityGate.resolve(false);
            terminalCode = "bootstrap_protocol_error";
            sessionFailed = true;
            session.close();
            break;
          }
          const bootstrap = evaluateCapabilityBootstrap(capabilities, message);
          lifecycle.push(...bootstrap.lifecycle);
          if (!bootstrap.continueReview) {
            capabilityGate.resolve(false);
            terminalCode = bootstrap.blockingCode;
            sessionFailed = terminalCode === "bootstrap_protocol_error";
            session.close();
            break;
          }
          capabilityGate.resolve(true);
          continue;
        }

        if (message.type !== "system" && !capabilityGate.sourceDelivered()) {
          terminalCode = "bootstrap_protocol_error";
          sessionFailed = true;
          session.close();
          break;
        }

        const result = toolResult(message);
        if (result.kind === "ambiguous") {
          terminalCode = "session_error";
          sessionFailed = true;
          session.close();
          break;
        }
        if (result.kind === "one") {
          if (settledAttemptIds.has(result.id)) {
            terminalCode = "session_error";
            sessionFailed = true;
            session.close();
            break;
          }
          const attempt = attempts.get(result.id);
          attempts.delete(result.id);
          if (attempt === undefined) {
            terminalCode = "session_error";
            sessionFailed = true;
            session.close();
            break;
          }
          settledAttemptIds.add(result.id);
          if (attempt.tool === STRUCTURED_OUTPUT_TOOL) continue;
          const obligation = capabilities.obligations[0];
          if (obligation !== undefined) {
            const rawParts = rawTextParts(result.raw);
            if (result.failed || rawParts.length === 0) {
              lifecycle.push(event(obligation, "failed", attempt.tool, "tool_error", [], attempt.claim?.id ?? null));
            } else {
              admittedRawText.push(...rawParts);
              const evidenceHash = sha256(result.raw);
              lifecycle.push(event(obligation, "succeeded", attempt.tool, null, [evidenceHash], attempt.claim?.id ?? null));
              if (attempt.tool === CONTEXT7_RESOLVE_TOOL && attempt.claim !== null) {
                const ids = resolvedIdsByClaim.get(attempt.claim.id) ?? new Set<string>();
                for (const id of resolvedLibraryIds(result.raw, attempt.claim)) ids.add(id);
                resolvedIdsByClaim.set(attempt.claim.id, ids);
              } else if (attempt.tool === CONTEXT7_QUERY_TOOL && attempt.claim !== null) {
                successfulEvidence.set(attempt.claim.id, {
                  claimId: attempt.claim.id,
                  package: attempt.claim.package,
                  versionOrRange: attempt.claim.versionOrRange,
                  queryPurpose: attempt.claim.queryPurpose,
                  success: true,
                  evidenceHash,
                  seat: INDEPENDENT_REVIEW_SEAT,
                });
              }
            }
          }
          continue;
        }

        if (message.type === "result") {
          if (message.subtype !== "success") {
            terminalCode = "session_error";
            sessionFailed = true;
          } else {
            const structured = resultStructuredOutput(message);
            if (structured === undefined) terminalCode = "missing_structured_output";
            else {
              verdict = parseVerdict(
                structured,
                new Set(request.scope.claims.map((claim) => claim.id)),
                new Set(capabilities.externalClaims.map((claim) => claim.id)),
              );
              if (verdict === null) terminalCode = "invalid_structured_output";
              else if (copiesRawEvidence(verdict, [...admittedRawText, request.source])) {
                verdict = null;
                terminalCode = "raw_evidence_in_output";
              }
            }
          }
          break;
        }
      }
    } catch {
      terminalCode = "session_error";
      sessionFailed = true;
    } finally {
      capabilityGate.resolve(false);
      session.close();
    }

    if (!initSeen) {
      for (const obligation of capabilities.obligations) {
        lifecycle.push(event(obligation, "failed", null, "bootstrap_protocol_error"));
      }
      return makeOutcome("failed", capabilities, lifecycle, "bootstrap_protocol_error");
    }
    if (terminalCode === "server_unavailable" || terminalCode === "tool_unavailable") {
      return makeOutcome("capability_unavailable", capabilities, lifecycle, terminalCode);
    }
    if (sessionFailed) {
      for (const obligation of capabilities.obligations) {
        lifecycle.push(event(obligation, "failed", null, terminalCode ?? "session_error"));
      }
      return makeOutcome("failed", capabilities, lifecycle, terminalCode ?? "session_error");
    }
    if (verdict === null) {
      for (const obligation of capabilities.obligations) {
        lifecycle.push(event(obligation, "unsatisfied", null, terminalCode ?? "invalid_structured_output"));
      }
      return makeOutcome("unsatisfied", capabilities, lifecycle, terminalCode ?? "invalid_structured_output");
    }

    const declared = new Set(verdict.evidence.map((projection) => projection.claimId));
    const missing = capabilities.externalClaims.filter(
      (claim) => !declared.has(claim.id) || !successfulEvidence.has(claim.id),
    );
    if (missing.length > 0 && required) {
      for (const obligation of capabilities.obligations) {
        lifecycle.push(event(obligation, "unsatisfied", null, "required_evidence_missing"));
      }
      return makeOutcome(
        "unsatisfied",
        capabilities,
        lifecycle,
        "required_evidence_missing",
        null,
        [...successfulEvidence.values()],
      );
    }
    for (const obligation of capabilities.obligations) {
      const hashes = [...successfulEvidence.values()].map((projection) => projection.evidenceHash);
      lifecycle.push(event(obligation, missing.length === 0 ? "satisfied" : "unsatisfied", null, null, hashes));
    }
    return makeOutcome(
      "completed",
      capabilities,
      lifecycle,
      null,
      verdict,
      [...successfulEvidence.values()],
    );
  }
}
