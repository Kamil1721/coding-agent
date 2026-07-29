/**
 * registry.ts — the model catalogue behind `GET /api/models`.
 *
 * =========================================================================
 * TWO TIERS, AND THEY ARE DIFFERENT TYPES, NOT A FLAG
 * =========================================================================
 *
 * - `included` — reachable through the owner's personal subscription over a
 *   subprocess SDK. Consumes QUOTA. **The `included` variant of
 *   {@link ModelCatalogueEntry} HAS NO COST FIELD AT ALL.** Not `costUsd: null`
 *   — absent. Unpriced by construction beats unpriced by convention: writing a
 *   dollar figure on to a subscription model is a compile error rather than a
 *   code-review question.
 *
 * - `metered` — reachable only with an API key, billed per token. This variant
 *   DOES carry prices, because for it they are real.
 *
 * =========================================================================
 * `available` IS COMPUTED FROM MEASURED AUTH STATE, NEVER OPTIMISTICALLY
 * =========================================================================
 *
 * For `included`, `available` requires a login that is a VERIFIED SUBSCRIPTION
 * method. "The CLI says it is logged in" is not enough, and the reason is
 * measured: an `ANTHROPIC_API_KEY` in the environment makes an unauthenticated
 * machine report `loggedIn: true` with `authMethod: "api_key"` — a BILLED path
 * presenting as a subscription. `ClaudeAgentAdapter.authStatus()` reports that
 * as `metered_key`, and this file treats it as UNAVAILABLE in the included
 * tier, naming why.
 *
 * An unrecognised `authMethod` is `unknown`, which is also unavailable. A new
 * vendor auth mode must show up as a question, not as a silent pass.
 *
 * For `metered`, availability is `checkCredential()` from `src/env.ts` — the
 * harness's existing presence check, which already rejects an empty,
 * whitespace-only or placeholder value — AND a fully verified price. A model
 * with no verified price is not runnable: a ceiling denominated in dollars
 * cannot be enforced without a per-MTok price, so running unpriced means
 * running uncapped (README, constraint 3).
 *
 * =========================================================================
 * WHERE THE MODEL IDS COME FROM, AND WHY THEY CARRY A CAVEAT
 * =========================================================================
 *
 * Named ids are taken from `PRICE_TABLE`, which is the only catalogue of model
 * ids in this tree. For the METERED tier that is exactly right — those are API
 * model ids. For the INCLUDED tier it is a borrowing, and it is flagged:
 * `modelIdConfirmed` is false on every named included entry, because neither
 * CLI's model list has been checked here, and STATUS.md section 4 already
 * records that `modelAliasFor` "has never been checked against a real Claude
 * Code client". Inventing plausible-looking ids instead would have been worse.
 *
 * Each provider therefore ALSO gets a `modelId: null` entry meaning "whatever
 * the CLI's own default is". That entry cannot have a wrong id, so it is the
 * one to pick when a named id is refused.
 */

import type { ModelPrice, Provider } from "../contracts.js";
import { BakeoffError, PRICE_TABLE, resolvePrice } from "../contracts.js";
import type { CredentialCheck } from "../env.js";
import { checkCredential } from "../env.js";
import type {
  SubscriptionAdapter,
  SubscriptionAuthStatus,
  SubscriptionAuthState,
  SubscriptionProvider,
} from "./types.js";
import { CLAUDE_LOGIN_REMEDIATION } from "./claude-agent.js";
import { CODEX_LOGIN_REMEDIATION } from "./codex.js";

/** Which SDK drives an `included` entry. */
export type SubscriptionDriver = "claude-agent-sdk" | "codex-sdk";

/** API-key variable per provider. Mirrors the seats in `src/config.ts`. */
export const API_KEY_ENV_NAMES: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: "ANTHROPIC_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
});

/** Presentation metadata for the two subscription providers. */
const SUBSCRIPTION_TOOLS: Readonly<
  Record<SubscriptionProvider, { driver: SubscriptionDriver; cli: string; label: string; remediation: string }>
> = Object.freeze({
  anthropic: {
    driver: "claude-agent-sdk",
    cli: "claude",
    label: "Claude Code",
    remediation: CLAUDE_LOGIN_REMEDIATION,
  },
  openai: {
    driver: "codex-sdk",
    cli: "codex",
    label: "Codex",
    remediation: CODEX_LOGIN_REMEDIATION,
  },
});

interface ModelEntryBase {
  /** Stable key for the HTTP API, e.g. `included:anthropic/claude-opus-5`. */
  readonly key: string;
  readonly provider: Provider;
  /** Human label for the picker. */
  readonly label: string;
  /** Vendor-native model id, or null for "the tool's own default". */
  readonly modelId: string | null;
  /**
   * Whether this entry can be run RIGHT NOW. Computed from measured auth state
   * and, for metered entries, from a verified price. Never optimistic.
   */
  readonly available: boolean;
  /**
   * Why — ALWAYS populated, including when `available` is true. A picker that
   * greys an option out without saying why is a support ticket.
   */
  readonly reason: string;
  /** The exact operator action that makes this available, or "" if it is. */
  readonly remediation: string;
}

/**
 * A model reachable on the personal subscription.
 *
 * NOTE WHAT IS NOT HERE: no cost, no price, no dollar figure. See the header.
 */
export interface IncludedModelEntry extends ModelEntryBase {
  readonly tier: "included";
  readonly driver: SubscriptionDriver;
  /** The CLI binary the SDK spawns. */
  readonly cliName: string;
  readonly authState: SubscriptionAuthState;
  readonly authMethod: string | null;
  readonly subscriptionTier: string | null;
  /** Whether the model id has been confirmed against the vendor's model list. */
  readonly modelIdConfirmed: boolean;
  /** What the owner spends on this entry, in words. Never a number. */
  readonly quotaNote: string;
}

/** Per-MTok prices for a metered entry. Real money, so real numbers. */
export interface MeteredPrice {
  readonly inputUsdPerMTok: number | null;
  readonly cacheReadUsdPerMTok: number | null;
  readonly cacheWrite5mUsdPerMTok: number | null;
  readonly cacheWrite1hUsdPerMTok: number | null;
  readonly outputUsdPerMTok: number | null;
  /** Fields resting on a stated assumption rather than a source. */
  readonly assumedFields: readonly string[];
  /** Fields with no known value. Any of these makes the entry unavailable. */
  readonly unverifiedFields: readonly string[];
}

/** A model reachable only with an API key. Billed per token. */
export interface MeteredModelEntry extends ModelEntryBase {
  readonly tier: "metered";
  /** NAME of the credential variable. Never a value. */
  readonly envName: string;
  readonly credential: CredentialCheck;
  /** Null when no price window is in force at the requested instant. */
  readonly price: MeteredPrice | null;
}

export type ModelCatalogueEntry = IncludedModelEntry | MeteredModelEntry;

export interface ModelCatalogue {
  readonly generatedAt: string;
  readonly entries: readonly ModelCatalogueEntry[];
  /** True when at least one entry can be run. */
  readonly anyAvailable: boolean;
}

export interface ModelCatalogueInput {
  /**
   * Measured auth state, one per subscription provider. A provider with no
   * entry here is reported as `unavailable` — NOT as available. An absent probe
   * is not evidence of a working login.
   */
  readonly authStatuses: readonly SubscriptionAuthStatus[];
  /** Instant the price windows are resolved at. */
  readonly atIsoInstant: string;
  /** Defaults to `process.env`. Read for credential PRESENCE only. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `PRICE_TABLE`. */
  readonly priceTable?: readonly ModelPrice[];
}

/**
 * Build the catalogue from already-measured auth state.
 *
 * Pure and synchronous, so it can be unit-tested against every auth state
 * without any credential or CLI.
 */
export function buildModelCatalogue(input: ModelCatalogueInput): ModelCatalogue {
  const env = input.env ?? process.env;
  const table = input.priceTable ?? PRICE_TABLE;
  const byProvider = new Map<SubscriptionProvider, SubscriptionAuthStatus>();
  for (const status of input.authStatuses) byProvider.set(status.provider, status);

  const entries: ModelCatalogueEntry[] = [];

  for (const provider of ["anthropic", "openai"] as const) {
    const tool = SUBSCRIPTION_TOOLS[provider];
    const status = byProvider.get(provider) ?? unprobed(provider, tool.remediation);
    entries.push(includedEntry(provider, null, `${tool.label} default model`, status, true));
    for (const modelId of distinctModelIds(table, provider)) {
      entries.push(
        includedEntry(provider, modelId, `${labelFor(table, provider, modelId)} (${tool.label})`, status, false),
      );
    }
  }

  for (const provider of ["anthropic", "moonshot", "deepseek", "openai"] as const) {
    for (const modelId of distinctModelIds(table, provider)) {
      entries.push(meteredEntry(provider, modelId, table, input.atIsoInstant, env));
    }
  }

  return {
    generatedAt: input.atIsoInstant,
    entries,
    anyAvailable: entries.some((entry) => entry.available),
  };
}

/**
 * Probe both adapters, then build the catalogue.
 *
 * The probes are local credential-store reads. They consume no quota and cost
 * nothing, so a dashboard may call this on every page load.
 *
 * A probe that rejects — which the adapters are written never to do — is caught
 * here and becomes an `unavailable` entry rather than a failed HTTP request. A
 * model picker that returns 500 because one CLI is missing is a worse outcome
 * than one that shows the other provider and explains the gap.
 */
export async function loadModelCatalogue(
  adapters: readonly SubscriptionAdapter[],
  options: { readonly atIsoInstant?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ModelCatalogue> {
  const statuses = await Promise.all(
    adapters.map(async (adapter): Promise<SubscriptionAuthStatus> => {
      try {
        return await adapter.authStatus();
      } catch (error) {
        const message = error instanceof Error ? error.message : "an unknown error";
        return {
          provider: adapter.provider,
          state: "unavailable",
          method: null,
          subscriptionTier: null,
          probe: "not_probed",
          detail: `the ${adapter.displayName} auth probe failed: ${message}`,
          remediation: SUBSCRIPTION_TOOLS[adapter.provider].remediation,
        };
      }
    }),
  );
  const built: ModelCatalogueInput = {
    authStatuses: statuses,
    atIsoInstant: options.atIsoInstant ?? new Date().toISOString(),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  return buildModelCatalogue(built);
}

/* ------------------------------------------------------------------------
 * Internals
 * --------------------------------------------------------------------- */

function unprobed(provider: SubscriptionProvider, remediation: string): SubscriptionAuthStatus {
  return {
    provider,
    state: "unavailable",
    method: null,
    subscriptionTier: null,
    probe: "not_probed",
    detail: "no auth probe was supplied for this provider, so its login state is unknown.",
    remediation,
  };
}

function distinctModelIds(table: readonly ModelPrice[], provider: Provider): readonly string[] {
  const seen = new Set<string>();
  for (const row of table) {
    if (row.provider === provider) seen.add(row.modelId);
  }
  return [...seen].sort();
}

function labelFor(table: readonly ModelPrice[], provider: Provider, modelId: string): string {
  const row = table.find((entry) => entry.provider === provider && entry.modelId === modelId);
  return row?.label ?? modelId;
}

/**
 * The availability rule for the included tier.
 *
 * Only `authenticated` passes. `metered_key` is called out separately because
 * it is the state that would otherwise spend real money behind a UI showing no
 * cost — a subscription run has no cost to show, so the UI would be telling the
 * truth about the wrong thing.
 */
function includedEntry(
  provider: SubscriptionProvider,
  modelId: string | null,
  label: string,
  status: SubscriptionAuthStatus,
  isDefaultModel: boolean,
): IncludedModelEntry {
  const tool = SUBSCRIPTION_TOOLS[provider];
  const available = status.state === "authenticated";

  const idCaveat = isDefaultModel
    ? ` The model is whatever ${tool.label} defaults to, so there is no model id to get wrong.`
    : ` The model id "${modelId ?? ""}" comes from this harness's PRICE_TABLE and has NOT been confirmed against ${tool.label}'s own model list; if the CLI refuses it, use the "${tool.label} default model" entry.`;

  const reason = available
    ? `Included in your ${tool.label} subscription — ${status.detail}${idCaveat}`
    : reasonForUnavailableIncluded(status, tool.label) + idCaveat;

  return {
    tier: "included",
    key: `included:${provider}/${modelId ?? "default"}`,
    provider,
    label,
    modelId,
    available,
    reason,
    remediation: available ? "" : status.remediation,
    driver: tool.driver,
    cliName: tool.cli,
    authState: status.state,
    authMethod: status.method,
    subscriptionTier: status.subscriptionTier,
    modelIdConfirmed: isDefaultModel,
    quotaNote:
      "Runs on this entry consume subscription QUOTA, not dollars: a rolling five-hour window plus a weekly cap. Token counts and rate-limit state are reported; there is no bill, so no cost is shown.",
  };
}

function reasonForUnavailableIncluded(status: SubscriptionAuthStatus, toolLabel: string): string {
  switch (status.state) {
    case "missing":
      return `Not signed in to ${toolLabel}. ${status.detail}`;
    case "metered_key":
      return `UNAVAILABLE ON THE SUBSCRIPTION TIER: ${status.detail} Use the metered entry for this model if you intend to be billed.`;
    case "unknown":
      return `Login state could not be read, so this is not offered. ${status.detail}`;
    case "unavailable":
      return `The ${toolLabel} CLI could not be probed. ${status.detail}`;
    case "authenticated":
      // Unreachable: `available` would be true. Kept so the switch is
      // exhaustive and a new state cannot fall through to a silent default.
      return status.detail;
    default: {
      const exhaustive: never = status.state;
      return String(exhaustive);
    }
  }
}

function meteredEntry(
  provider: Provider,
  modelId: string,
  table: readonly ModelPrice[],
  atIsoInstant: string,
  env: NodeJS.ProcessEnv,
): MeteredModelEntry {
  const envName = API_KEY_ENV_NAMES[provider];
  const credential = checkCredential(envName, env);
  const label = labelFor(table, provider, modelId);

  let price: MeteredPrice | null = null;
  let priceProblem: string | null = null;
  try {
    const resolved = resolvePrice(provider, modelId, atIsoInstant, table);
    price = {
      inputUsdPerMTok: resolved.price.inputUsdPerMTok,
      cacheReadUsdPerMTok: resolved.price.cacheReadUsdPerMTok,
      cacheWrite5mUsdPerMTok: resolved.price.cacheWrite5mUsdPerMTok,
      cacheWrite1hUsdPerMTok: resolved.price.cacheWrite1hUsdPerMTok,
      outputUsdPerMTok: resolved.price.outputUsdPerMTok,
      assumedFields: [...resolved.assumedFields],
      unverifiedFields: [...resolved.unverifiedFields],
    };
    if (resolved.unverifiedFields.length > 0) {
      priceProblem = `no verified price for ${resolved.unverifiedFields.join(", ")}. A dollar ceiling cannot be enforced without one, so running this model would be running uncapped.`;
    }
  } catch (error) {
    priceProblem =
      error instanceof BakeoffError
        ? `${error.message} (${error.code})`
        : "the price for this model could not be resolved.";
  }

  const available = credential.present && priceProblem === null;
  const reason = available
    ? `Billed per token against ${envName}.${assumptionNote(price)}`
    : credential.present
      ? `Priced entry is not runnable: ${priceProblem ?? "unknown price problem"}`
      : `${envName} is not set (${credential.problem ?? "missing"}), so this metered model cannot run.`;

  return {
    tier: "metered",
    key: `metered:${provider}/${modelId}`,
    provider,
    label,
    modelId,
    available,
    reason,
    remediation: credential.present
      ? priceProblem === null
        ? ""
        : "Confirm the price on the vendor's own pricing page and add it to PRICE_TABLE in src/contracts.ts."
      : `Set ${envName} in your .env (the file is gitignored). Never paste the value into a chat transcript.`,
    envName,
    credential,
    price,
  };
}

function assumptionNote(price: MeteredPrice | null): string {
  if (price === null || price.assumedFields.length === 0) return "";
  return ` Note: ${price.assumedFields.join(", ")} rest${price.assumedFields.length === 1 ? "s" : ""} on a stated assumption rather than a vendor source.`;
}
