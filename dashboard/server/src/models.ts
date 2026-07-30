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
 * CLAUDE ONLY — SEE `isOfferedProvider`. `GET /api/models` serves Anthropic rows
 * and nothing else. Two removals got it there, and both were the owner's call
 * rather than a cleanup:
 *
 * MOONSHOT AND DEEPSEEK ARE GONE — REMOVED BY THE OWNER, 2026-07-30. This
 * docblock used to argue the other way, and that argument is recorded here so it
 * is not silently re-litigated: "Listing them disabled, with the reason, is more
 * honest than hiding them: it answers 'why can't I pick Kimi here?' in the UI
 * instead of in someone's memory." The owner has now answered that question the
 * other way — "we only use Claude" — so `kimi-k3` and `deepseek-v4-pro` no
 * longer exist as rows at all, and the `metered()` helper that built them is
 * deleted. THE OWNER WINS; do not put them back on the strength of the
 * paragraph above. `ModelTier` keeps its `"metered"` member because it still
 * describes a RUN's billing (`src/lib/cost.ts` reads it to decide whether a run
 * can have a dollar cost at all) — no row served here carries it any more.
 *
 * THE CODEX ROW STILL EXISTS BUT IS NEVER OFFERED. Owner decision 2026-07-28,
 * spec section 14: "Claude only. Codex stays in the tree as working code but is
 * not a selectable provider for orchestration runs." So `CODEX_DEFAULT_MODEL_ID`
 * stays resolvable — `POST /api/runs` answers a stale caller with 409 and the
 * reason, which is a better answer than 400 "unknown model", and any historical
 * run keeps a label — while `list()` filters it out so no UI can offer it.
 * `builders/codex-builder.ts` is deliberately NOT deleted: section 14 records a
 * verified config path that restricts a Codex build MORE strongly than Claude's
 * (`permissions.sealed` covers Bash and every subprocess), and the decision "may
 * reverse". Note what section 14 also says: the older claim that Codex has no
 * equivalent of `sandbox.filesystem.denyRead` is FALSE of `CodexOptions.config`
 * and true only of `ThreadOptions`. The reason Codex is not offered is the
 * owner's scope decision, not that boundary.
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
 * dashboard can actually verify by running. Retained, unofferable: see the
 * header, and `isOfferedProvider` below.
 *
 * `DASHBOARD_CODEX_MODELS` — an env var that let the owner name extra Codex ids
 * without a code change — is REMOVED (2026-07-30) along with the reader that
 * parsed it. Every id it could add belonged to a provider no run may select, so
 * it could only ever grow the unofferable half of the catalog.
 */
export const CODEX_DEFAULT_MODEL_ID = "codex-default";

/**
 * Whether a provider may be SELECTED for a run — the single declaration site for
 * "Claude only" (owner, 2026-07-28, spec section 14).
 *
 * Deliberately a predicate over the provider rather than a flag on each row: a
 * per-row flag can be set inconsistently by whoever adds the next row, and a
 * provider is the granularity the owner's decision was actually made at.
 *
 * `list()` filters on this, so it decides what any UI can show. `http.ts` reads
 * it too, so a refusal explains itself with the scope decision instead of
 * telling the caller to authenticate a CLI that would not help.
 */
export function isOfferedProvider(provider: ModelOption["provider"]): boolean {
  return provider === "anthropic";
}

/**
 * Why the Codex row is unavailable — scope, not authentication.
 *
 * Unconditional on purpose: `codex login` would make the CLI reachable and would
 * still not make it selectable, so reporting the auth detail here would invite
 * the owner to fix the wrong thing.
 */
const CODEX_NOT_OFFERED_REASON =
  "Claude only. The owner scoped the Codex provider out of the dashboard on 2026-07-28 " +
  "(spec section 14): the builder stays in the tree as working code, but no run may select it. " +
  "Nothing to authenticate — `codex login` would not change this.";

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

    // NOT FILTERED HERE. `entries()` is the resolver's view and keeps the Codex
    // row so a stale caller gets 409 plus a reason and an old run keeps a label;
    // `list()` below is the view a UI sees, and that one filters.
    rows.push({
      option: {
        id: CODEX_DEFAULT_MODEL_ID,
        label: "Codex (CLI default model)",
        provider: "openai",
        tier: "included",
        available: false,
        reason: CODEX_NOT_OFFERED_REASON,
      },
      effort: null,
    });

    this.#entries = rows;
    this.#cachedAtMs = this.#nowMs();
    return rows;
  }

  /**
   * What a caller may CHOOSE from — the offered half of the catalog.
   *
   * An unavailable row is still listed here when its provider is offered: the
   * picker's job is to say why `default` cannot run when the CLI is not logged
   * in, and it cannot say that about a row it never receives. Unofferable is a
   * different fact from unavailable, and only the first one is hidden.
   */
  async list(): Promise<readonly ModelOption[]> {
    return (await this.entries())
      .map((entry) => entry.option)
      .filter((option) => isOfferedProvider(option.provider));
  }

  async resolve(modelId: string): Promise<CatalogEntry | null> {
    const entries = await this.entries();
    return entries.find((entry) => entry.option.id === modelId) ?? null;
  }

  invalidate(): void {
    this.#entries = null;
  }
}
