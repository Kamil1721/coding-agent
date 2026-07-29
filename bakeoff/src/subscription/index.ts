/**
 * The subscription-adapter module: the dashboard's execution path.
 *
 * NOT the bake-off path. The bake-off drives vendors over HTTP through a budget
 * proxy with API keys and dollar ceilings (`src/adapters.ts`, `src/proxy.ts`).
 * This drives two CLI SUBPROCESSES on the owner's personal subscriptions, with
 * no API key and no dollar figures at all. The two share only `src/redact.ts`.
 *
 * Read `types.ts` first: it carries the reasoning for the split, the unpriced
 * invariant, and the rule that no method here throws for an expected condition.
 */

export type {
  AuthProbe,
  Autonomy,
  ModuleLoader,
  RateLimitKind,
  RateLimitSignal,
  RateLimitState,
  SubscriptionAdapter,
  SubscriptionAuthState,
  SubscriptionAuthStatus,
  SubscriptionEvent,
  SubscriptionEventEnvelope,
  SubscriptionFailure,
  SubscriptionFailureKind,
  SubscriptionOutcome,
  SubscriptionProvider,
  SubscriptionResumeOptions,
  SubscriptionRunOptions,
  SubscriptionUsage,
  ToolStatus,
} from "./types.js";
export {
  RESUME_CONTINUATION_PROMPT,
  SUBSCRIPTION_PROVIDERS,
  assertUnpriced,
  defaultModuleLoader,
  emptyUsage,
  notRateLimited,
} from "./types.js";

export type { AnthropicRateLimitInfo } from "./rate-limit.js";
export {
  anthropicLimitKind,
  anthropicRateLimitState,
  describeRateLimit,
  matchesVendorPrefix,
  mergeRateLimitState,
  normalizeUtilization,
  rateLimitFromAssistantError,
  rateLimitFromHttpStatus,
  rateLimitFromText,
  rateLimitFromVendorPrefix,
  readAnthropicRateLimitInfo,
  resetsAtToIso,
  retryAfterFromText,
  secondsUntil,
} from "./rate-limit.js";

export type { ClaudeAgentAdapterOptions } from "./claude-agent.js";
export {
  AGENT_SDK_INSTALL_HINT,
  ANTHROPIC_BILLED_ENV_NAMES,
  ANTHROPIC_SUBSCRIPTION_AUTH_METHODS,
  CLAUDE_CLI_NAME,
  CLAUDE_LOGIN_REMEDIATION,
  ClaudeAgentAdapter,
} from "./claude-agent.js";

export type { CodexAdapterOptions } from "./codex.js";
export {
  CODEX_BILLED_ENV_NAMES,
  CODEX_CLI_NAME,
  CODEX_LOGIN_REMEDIATION,
  CODEX_SDK_INSTALL_HINT,
  CodexAdapter,
} from "./codex.js";

export type {
  IncludedModelEntry,
  MeteredModelEntry,
  MeteredPrice,
  ModelCatalogue,
  ModelCatalogueEntry,
  ModelCatalogueInput,
  SubscriptionDriver,
} from "./registry.js";
export { API_KEY_ENV_NAMES, buildModelCatalogue, loadModelCatalogue } from "./registry.js";
