/**
 * models.ts — what `GET /api/models` returns, and where each id comes from.
 *
 * THE ANTHROPIC ROWS ARE NOT HARDCODED. They are read from the Claude CLI's own
 * model list via the Agent SDK's `supportedModels()` control request, which
 * spawns the CLI, asks it, and sends no prompt — so building the catalog costs
 * no quota. That matters more than it looks: STATUS section 4 records
 * `modelAliasFor` as never having been checked against a real Claude Code
 * client, and a wrong alias silently measures a different model than the one
 * the UI says was chosen. Asking the client is the only way to be right about
 * this, and it stays right when the CLI changes.
 *
 * Verified in this environment (CLI 2.1.220), the list came back as:
 *   default        -> claude-opus-5[1m]      efforts low..max
 *   opus[1m]       -> claude-opus-5[1m]      efforts low..max
 *   claude-fable-5[1m] -> claude-fable-5     efforts low..max
 *   sonnet         -> claude-sonnet-5        efforts low..max
 *   haiku          -> claude-haiku-4-5-...   no effort support
 *
 * THE OPENAI ROW IS A SENTINEL, DELIBERATELY. The Codex CLI exposes no model
 * list command, and `codex login status` reports "Not logged in" here, so there
 * is no authenticated client to ask. STATUS section 1.3 already records that
 * `gpt-5.6-luna` is a display name never confirmed against any vendor model
 * list — so hardcoding it (or its siblings) would be exactly the guess that
 * document warns about. Instead the dashboard offers CODEX_DEFAULT_MODEL_ID,
 * which means "start the thread with no `model` option and let the CLI use the
 * model the owner configured". That is a claim the code can keep.
 * `DASHBOARD_CODEX_MODELS` lets the owner name extra ids without a code change;
 * whatever is put there is the owner's assertion, not the dashboard's.
 *
 * MOONSHOT AND DEEPSEEK ARE LISTED AND ALWAYS UNAVAILABLE. They are metered
 * API-key vendors with no subprocess SDK; the bake-off harness drives them over
 * its budget proxy. Listing them disabled, with the reason, is more honest than
 * hiding them: it answers "why can't I pick Kimi here?" in the UI instead of in
 * someone's memory.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AnthropicEffort } from "bakeoff/dist/contracts.js";
import type { ModelOption } from "./api-types.js";
import type { AuthProbe } from "./auth.js";
import { subscriptionSubprocessEnvStrings } from "./subprocess-env.js";

/**
 * The one OpenAI id the dashboard is willing to assert.
 *
 * Not a vendor model id and not pretending to be one: it selects "whatever the
 * Codex CLI is configured to use", which is a fact about this machine that the
 * dashboard can actually verify by running.
 */
export const CODEX_DEFAULT_MODEL_ID = "codex-default";

/** Owner-supplied extra codex model ids, comma-separated. */
export const CODEX_MODELS_ENV = "DASHBOARD_CODEX_MODELS";

/** How long the Anthropic model list is reused before re-asking the CLI. */
export const CATALOG_CACHE_MS = 60_000;

/**
 * Effort for the builder seat.
 *
 * doc 03 section 5 caveat on rank 4: Opus 5's curve is high 1606 @ $10.41 ->
 * xhigh 1693 @ $14.26 -> max 1720 @ $17.79, so the last rung buys +27 Elo for
 * +25% — the worst marginal return on the curve — and Anthropic's own guidance
 * for Opus 5 is "start with high, the default". Effort is worth 250-497 Elo, so
 * it is recorded on every run (held-constant variable 1) even though the
 * dashboard is not an experiment.
 */
export const BUILDER_EFFORT: AnthropicEffort = "high";

const ANTHROPIC_EFFORT_ORDER: readonly AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** A catalog row plus the non-UI facts the builder driver needs. */
export interface CatalogEntry {
  readonly option: ModelOption;
  /**
   * Effort rung to pass to the SDK, or null when this model has no effort
   * parameter (the CLI reports `supportedEffortLevels` per model; `haiku` has
   * none). Passing an unsupported rung is a silent downgrade at best.
   */
  readonly effort: AnthropicEffort | null;
}

function metered(id: string, label: string, provider: "moonshot" | "deepseek"): ModelOption {
  return {
    id,
    label,
    provider,
    tier: "metered",
    available: false,
    reason:
      "Metered vendor: billed per token against an API key. The dashboard drives only the two " +
      "subscription CLIs (Claude, Codex) as subprocesses and holds no API key. This model is " +
      "reachable from the bake-off harness, which speaks to it over its budget proxy.",
  };
}

/** Constant rows: true regardless of what any CLI reports. */
export const METERED_MODELS: readonly ModelOption[] = Object.freeze([
  metered("kimi-k3", "Kimi K3", "moonshot"),
  metered("deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek"),
]);

function chooseEffort(info: ModelInfo): AnthropicEffort | null {
  const supported = info.supportedEffortLevels;
  if (info.supportsEffort === false) return null;
  if (supported === undefined || supported.length === 0) return null;
  if (supported.includes(BUILDER_EFFORT)) return BUILDER_EFFORT;
  // Fall back to the highest rung this model does offer, so a model without
  // `high` still runs at a recorded, deliberate effort rather than at whatever
  // the CLI defaults to.
  for (let i = ANTHROPIC_EFFORT_ORDER.length - 1; i >= 0; i -= 1) {
    const rung = ANTHROPIC_EFFORT_ORDER[i];
    if (rung !== undefined && supported.includes(rung)) return rung;
  }
  return null;
}

function anthropicRow(info: ModelInfo, available: boolean, reason: string | null): CatalogEntry {
  const resolved = info.resolvedModel;
  const label =
    resolved !== undefined && resolved !== info.value ? `${info.displayName} (${resolved})` : info.displayName;
  return {
    option: { id: info.value, label, provider: "anthropic", tier: "included", available, reason },
    effort: chooseEffort(info),
  };
}

/**
 * Ask the Claude CLI for its model list.
 *
 * `supportedModels()` is a control request on a `query()` that is never
 * iterated, so the prompt is never dispatched and no quota is consumed. The
 * query is closed and the abort controller fired in `finally`, because a leaked
 * CLI subprocess would keep the dashboard alive after shutdown.
 *
 * The child environment is the STRIPPED one, for the same reason `auth.ts`
 * probes with it: this spawns the CLI, and a CLI that finds `ANTHROPIC_API_KEY`
 * authenticates as a billed API client. Verified by reading the SDK: it does
 * `env: c = {...process.env}` as a DEFAULT, so supplying `options.env` REPLACES
 * the child environment rather than merging over it — a deleted name stays
 * deleted.
 */
export async function fetchAnthropicModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly ModelInfo[]> {
  const abortController = new AbortController();
  const session = query({
    // Never sent: the query is closed before the stream is consumed.
    prompt: "model catalog probe",
    options: {
      abortController,
      tools: [],
      maxTurns: 1,
      permissionMode: "plan",
      // Do not load the owner's CLAUDE.md, settings or plugins to ask a
      // question about model names.
      settingSources: [],
      env: subscriptionSubprocessEnvStrings(env),
    },
  });
  try {
    return await session.supportedModels();
  } finally {
    try {
      session.close();
    } catch {
      // Closing an already-dead subprocess is not an error worth surfacing.
    }
    abortController.abort();
  }
}

export class ModelCatalog {
  readonly #auth: AuthProbe;
  readonly #env: NodeJS.ProcessEnv;
  #entries: readonly CatalogEntry[] | null = null;
  #cachedAtMs = 0;
  readonly #nowMs: () => number;
  readonly #fetchModels: (env: NodeJS.ProcessEnv) => Promise<readonly ModelInfo[]>;

  constructor(
    auth: AuthProbe,
    env: NodeJS.ProcessEnv = process.env,
    fetchModels: (env: NodeJS.ProcessEnv) => Promise<readonly ModelInfo[]> = fetchAnthropicModels,
    nowMs: () => number = Date.now,
  ) {
    this.#auth = auth;
    this.#env = env;
    this.#fetchModels = fetchModels;
    this.#nowMs = nowMs;
  }

  async entries(): Promise<readonly CatalogEntry[]> {
    const cached = this.#entries;
    if (cached !== null && this.#nowMs() - this.#cachedAtMs < CATALOG_CACHE_MS) return cached;

    const auth = await this.#auth.status();
    const rows: CatalogEntry[] = [];

    if (auth.claude === "ok") {
      let infos: readonly ModelInfo[] = [];
      let failure: string | null = null;
      try {
        infos = await this.#fetchModels(this.#env);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure !== null || infos.length === 0) {
        rows.push({
          option: {
            id: "default",
            label: "Claude (CLI default model)",
            provider: "anthropic",
            tier: "included",
            available: true,
            reason: null,
          },
          effort: BUILDER_EFFORT,
        });
      } else {
        for (const info of infos) rows.push(anthropicRow(info, true, null));
      }
    } else {
      rows.push({
        option: {
          id: "default",
          label: "Claude (CLI default model)",
          provider: "anthropic",
          tier: "included",
          available: false,
          reason: auth.claudeDetail,
        },
        effort: BUILDER_EFFORT,
      });
    }

    const codexAvailable = auth.codex === "ok";
    rows.push({
      option: {
        id: CODEX_DEFAULT_MODEL_ID,
        label: "Codex (CLI default model)",
        provider: "openai",
        tier: "included",
        available: codexAvailable,
        reason: codexAvailable ? null : auth.codexDetail,
      },
      effort: null,
    });
    for (const extra of this.#extraCodexModels()) {
      rows.push({
        option: {
          id: extra,
          label: `Codex: ${extra}`,
          provider: "openai",
          tier: "included",
          available: codexAvailable,
          reason: codexAvailable
            ? null
            : auth.codexDetail,
        },
        effort: null,
      });
    }

    for (const option of METERED_MODELS) rows.push({ option, effort: null });

    this.#entries = rows;
    this.#cachedAtMs = this.#nowMs();
    return rows;
  }

  async list(): Promise<readonly ModelOption[]> {
    return (await this.entries()).map((entry) => entry.option);
  }

  async resolve(modelId: string): Promise<CatalogEntry | null> {
    const entries = await this.entries();
    return entries.find((entry) => entry.option.id === modelId) ?? null;
  }

  invalidate(): void {
    this.#entries = null;
  }

  #extraCodexModels(): readonly string[] {
    const raw = (this.#env[CODEX_MODELS_ENV] ?? "").trim();
    if (raw.length === 0) return [];
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part !== CODEX_DEFAULT_MODEL_ID);
  }
}
