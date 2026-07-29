/**
 * env.ts — credential resolution and preflight.
 *
 * SECURITY CONTRACT, ABSOLUTE:
 *   - This module reads environment variables by NAME, taken from the
 *     configuration matrix. It NEVER returns, prints, persists, hashes or
 *     length-reports a credential value, and it never derives a fingerprint,
 *     prefix or last-4 from one. A partial is still a leak.
 *   - The only thing that leaves this module about a value is a boolean and a
 *     problem code.
 *   - The harness forwards credentials into the sandbox BY VARIABLE NAME.
 *     Nothing in this codebase needs to materialise a secret in TypeScript.
 *
 * OPERATIONAL CONTRACT: the harness must fail clean and explain itself when a
 * key is missing. It must never crash with a stack trace, and it must never
 * silently skip a configuration. {@link preflight} reports exactly which
 * configurations are runnable, which are blocked, and what clears each blocker.
 */

import {
  BakeoffError,
  PRICE_FIELDS,
  resolvePrice,
  validateSeatEffort,
} from "./contracts.js";
import type {
  BakeoffConfig,
  ModelSeat,
  PriceField,
  PriceStatus,
  Provider,
  SeatRole,
} from "./contracts.js";
import { CONFIGS, validateConfigMatrix } from "./config.js";

/* -------------------------------------------------------------------------
 * Credentials
 * ---------------------------------------------------------------------- */

/** Why a credential is unusable. Never accompanied by any part of the value. */
export type CredentialProblem = "missing" | "empty" | "whitespace_only" | "placeholder";

export interface CredentialCheck {
  readonly envName: string;
  readonly present: boolean;
  /** Non-null exactly when `present` is false. */
  readonly problem: CredentialProblem | null;
}

const PLACEHOLDER_RE =
  /^(?:changeme|change_me|placeholder|your[-_ ].*|<.*>|todo|xxx+|example|replace_me|null|undefined|none)$/i;

/**
 * Check one credential's presence and shape.
 *
 * A value equal to its own variable name (a copy-paste of .env.example) counts
 * as a placeholder: it would otherwise sail through presence checks and fail
 * mid-run, and doc 02 section 1.5 records that an invalid credential "does not
 * block the session from continuing" — a bad key silently burns hours.
 */
export function checkCredential(
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
): CredentialCheck {
  const raw = env[envName];
  if (raw === undefined) return { envName, present: false, problem: "missing" };
  if (raw.length === 0) return { envName, present: false, problem: "empty" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { envName, present: false, problem: "whitespace_only" };
  if (PLACEHOLDER_RE.test(trimmed) || trimmed === envName) {
    return { envName, present: false, problem: "placeholder" };
  }
  return { envName, present: true, problem: null };
}

/** Distinct credential variable NAMES a configuration needs. */
export function requiredEnvNamesFor(config: BakeoffConfig): readonly string[] {
  return [...new Set(config.seats.map((s) => s.envKeyName))].sort();
}

/** Non-secret endpoint override variable for a provider. */
export function baseUrlEnvNameFor(provider: Provider): string {
  const names: Readonly<Record<Provider, string>> = {
    anthropic: "ANTHROPIC_BASE_URL",
    moonshot: "MOONSHOT_BASE_URL",
    deepseek: "DEEPSEEK_BASE_URL",
    openai: "OPENAI_BASE_URL",
  };
  return names[provider];
}

/* -------------------------------------------------------------------------
 * Preflight
 * ---------------------------------------------------------------------- */

export type BlockerKind =
  | "missing_credential"
  | "unpriced_model"
  | "invalid_effort"
  | "matrix_invariant";

export interface Blocker {
  readonly kind: BlockerKind;
  readonly configId: string;
  readonly seatRole: SeatRole | null;
  readonly detail: string;
  /** Exact operator action that clears it. Never contains a secret. */
  readonly remediation: string;
}

export type WarningKind = "assumed_pricing" | "endpoint_override" | "price_window_expiring";

export interface PreflightWarning {
  readonly kind: WarningKind;
  readonly configId: string;
  readonly seatRole: SeatRole | null;
  readonly detail: string;
}

export interface SeatPricingReadiness {
  readonly priced: boolean;
  readonly priceLabel: string | null;
  readonly fieldStatus: Readonly<Record<PriceField, PriceStatus>> | null;
  readonly assumedFields: readonly PriceField[];
  readonly unverifiedFields: readonly PriceField[];
  /** Non-null when the price could not be resolved at all. */
  readonly problem: string | null;
}

export interface SeatReadiness {
  readonly role: SeatRole;
  readonly provider: Provider;
  readonly modelId: string;
  readonly effort: string;
  readonly effortSource: string;
  readonly credential: CredentialCheck;
  readonly effortValid: boolean;
  readonly pricing: SeatPricingReadiness;
}

/**
 * - `ready`                  — runnable, every price primary-sourced.
 * - `ready_with_assumptions` — runnable, but at least one price field rests on
 *                              a stated assumption. Dollar figures from this
 *                              configuration carry that provenance.
 * - `blocked`                — NOT runnable. Never silently skipped; the
 *                              blockers say exactly what clears it.
 */
export type ConfigStatus = "ready" | "ready_with_assumptions" | "blocked";

export interface ConfigReadiness {
  readonly configId: string;
  readonly label: string;
  readonly status: ConfigStatus;
  readonly runnable: boolean;
  readonly seats: readonly SeatReadiness[];
  readonly blockers: readonly Blocker[];
  readonly warnings: readonly PreflightWarning[];
  readonly requiredEnvNames: readonly string[];
  readonly missingEnvNames: readonly string[];
}

export interface PreflightReport {
  readonly generatedAt: string;
  /** Instant used to resolve price windows. */
  readonly pricedAt: string;
  readonly configs: readonly ConfigReadiness[];
  readonly runnableConfigIds: readonly string[];
  readonly blockedConfigIds: readonly string[];
  /** Union of every missing credential NAME across all configurations. */
  readonly missingEnvNames: readonly string[];
  readonly blockers: readonly Blocker[];
  readonly warnings: readonly PreflightWarning[];
}

export interface PreflightOptions {
  /** Environment to inspect. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** ISO-8601 instant for price-window resolution. Defaults to now. */
  readonly at?: string;
}

function pricingReadinessFor(seat: ModelSeat, atIsoInstant: string): SeatPricingReadiness {
  try {
    const resolved = resolvePrice(seat.provider, seat.modelId, atIsoInstant);
    const unpriced = PRICE_FIELDS.filter((f) => {
      switch (f) {
        case "input":
          return resolved.price.inputUsdPerMTok === null;
        case "cacheRead":
          return resolved.price.cacheReadUsdPerMTok === null;
        case "cacheWrite5m":
          return resolved.price.cacheWrite5mUsdPerMTok === null;
        case "cacheWrite1h":
          return resolved.price.cacheWrite1hUsdPerMTok === null;
        case "output":
          return resolved.price.outputUsdPerMTok === null;
        default:
          return true;
      }
    });
    return {
      priced: unpriced.length === 0,
      priceLabel: resolved.price.label,
      fieldStatus: resolved.price.fieldStatus,
      assumedFields: resolved.assumedFields,
      unverifiedFields: unpriced,
      problem:
        unpriced.length === 0
          ? null
          : `no price for field(s): ${unpriced.join(", ")}`,
    };
  } catch (error) {
    const message = error instanceof BakeoffError ? error.message : String(error);
    return {
      priced: false,
      priceLabel: null,
      fieldStatus: null,
      assumedFields: [],
      unverifiedFields: [...PRICE_FIELDS],
      problem: message,
    };
  }
}

/**
 * Report exactly which configurations can run and what blocks the rest.
 *
 * A configuration is blocked when a credential is missing, an effort rung does
 * not exist on its provider's ladder, or a price is unknown. Unknown pricing is
 * a hard block by design: the hard cost ceiling of constraint 3 is checked
 * before every API call in dollars, and it cannot be enforced without a
 * per-MTok price. Running unpriced would mean running uncapped.
 */
export function preflight(
  configs: readonly BakeoffConfig[] = CONFIGS,
  options: PreflightOptions = {},
): PreflightReport {
  const env = options.env ?? process.env;
  const pricedAt = options.at ?? new Date().toISOString();
  const generatedAt = new Date().toISOString();

  const matrixProblems = validateConfigMatrix(configs);

  const configReports: ConfigReadiness[] = [];
  const allBlockers: Blocker[] = [];
  const allWarnings: PreflightWarning[] = [];
  const allMissing = new Set<string>();

  for (const config of configs) {
    const blockers: Blocker[] = [];
    const warnings: PreflightWarning[] = [];
    const seats: SeatReadiness[] = [];
    const missing = new Set<string>();
    const warnedEndpointProviders = new Set<Provider>();

    for (const problem of matrixProblems.filter((p) => p.configId === config.id)) {
      blockers.push({
        kind: "matrix_invariant",
        configId: config.id,
        seatRole: null,
        detail: problem.problem,
        remediation: "Fix the configuration matrix in src/config.ts before running anything.",
      });
    }

    // One credential check per distinct variable NAME, so a variable shared by
    // four seats produces one blocker rather than four copies of it.
    const credentialChecks = new Map<string, CredentialCheck>();
    for (const envName of requiredEnvNamesFor(config)) {
      const check = checkCredential(envName, env);
      credentialChecks.set(envName, check);
      if (check.present) continue;

      missing.add(envName);
      allMissing.add(envName);
      const consumers = config.seats
        .filter((s) => s.envKeyName === envName)
        .map((s) => `${s.role} (${s.provider}/${s.modelId})`);
      blockers.push({
        kind: "missing_credential",
        configId: config.id,
        seatRole: null,
        detail: `${envName} is ${check.problem}; needed by: ${consumers.join(", ")}`,
        remediation:
          `Set ${envName} in the environment. Copy .env.example to .env and fill it in your ` +
          "editor, or export it in the shell that launches the harness. Never paste a key into a chat " +
          "transcript: transcripts are persisted, and a pasted key must then be rotated.",
      });
    }

    for (const seat of config.seats) {
      const credential =
        credentialChecks.get(seat.envKeyName) ?? checkCredential(seat.envKeyName, env);

      const effort = validateSeatEffort(seat);
      if (!effort.valid) {
        blockers.push({
          kind: "invalid_effort",
          configId: config.id,
          seatRole: seat.role,
          detail: `${seat.provider}/${seat.modelId}: ${effort.problem ?? "invalid effort"}`,
          remediation: "Correct the seat's effort rung in src/config.ts.",
        });
      }

      const pricing = pricingReadinessFor(seat, pricedAt);
      if (!pricing.priced) {
        blockers.push({
          kind: "unpriced_model",
          configId: config.id,
          seatRole: seat.role,
          detail: `${seat.provider}/${seat.modelId}: ${pricing.problem ?? "no price"}`,
          remediation:
            `Retrieve the list price (and confirm the API model ID) for ${seat.provider}/${seat.modelId} ` +
            "from the vendor's pricing page, then add or complete its entry in PRICE_TABLE in " +
            "src/contracts.ts. The hard cost ceiling is enforced in dollars before every API call and " +
            "cannot be enforced without a per-MTok price: running unpriced means running uncapped.",
        });
      } else if (pricing.assumedFields.length > 0) {
        warnings.push({
          kind: "assumed_pricing",
          configId: config.id,
          seatRole: seat.role,
          detail:
            `${seat.provider}/${seat.modelId}: price field(s) ${pricing.assumedFields.join(", ")} rest on a ` +
            "stated assumption, not a vendor source. Every dollar figure derived from this seat carries " +
            "that provenance in RunRecord.pricingBasis. Replace the assumption with the measured value " +
            "and re-cost from the recorded raw token counts.",
        });
      }

      const baseUrlName = baseUrlEnvNameFor(seat.provider);
      const override = env[baseUrlName];
      const overridden = seat.baseUrl !== null || (override !== undefined && override.trim().length > 0);
      if (overridden && !warnedEndpointProviders.has(seat.provider)) {
        warnedEndpointProviders.add(seat.provider);
        warnings.push({
          kind: "endpoint_override",
          configId: config.id,
          seatRole: seat.role,
          detail:
            `${seat.provider}/${seat.modelId} is routed through an endpoint override ` +
            `(${seat.baseUrl !== null ? "config baseUrl" : baseUrlName}). Two documented community cost ` +
            "blowups were gateway integration bugs that silently broke prompt caching, and a broken " +
            "cache is a 0%-hit-rate run at up to 2.4x the modelled bill, invisible in every log except " +
            "the cache usage fields. Verify cache_read_input_tokens is non-zero on the first call.",
        });
      }

      seats.push({
        role: seat.role,
        provider: seat.provider,
        modelId: seat.modelId,
        effort: seat.effort,
        effortSource: seat.effortSource,
        credential,
        effortValid: effort.valid,
        pricing,
      });
    }

    const runnable = blockers.length === 0;
    const hasAssumptions = seats.some((s) => s.pricing.assumedFields.length > 0);
    const status: ConfigStatus = !runnable
      ? "blocked"
      : hasAssumptions
        ? "ready_with_assumptions"
        : "ready";

    configReports.push({
      configId: config.id,
      label: config.label,
      status,
      runnable,
      seats,
      blockers,
      warnings,
      requiredEnvNames: requiredEnvNamesFor(config),
      missingEnvNames: [...missing].sort(),
    });
    allBlockers.push(...blockers);
    allWarnings.push(...warnings);
  }

  return {
    generatedAt,
    pricedAt,
    configs: configReports,
    runnableConfigIds: configReports.filter((c) => c.runnable).map((c) => c.configId),
    blockedConfigIds: configReports.filter((c) => !c.runnable).map((c) => c.configId),
    missingEnvNames: [...allMissing].sort(),
    blockers: allBlockers,
    warnings: allWarnings,
  };
}

/**
 * Throw a clean, actionable error if a configuration is not runnable.
 * Call this immediately before dispatching a run.
 */
export function assertConfigRunnable(report: PreflightReport, configId: string): void {
  const config = report.configs.find((c) => c.configId === configId);
  if (config === undefined) {
    throw new BakeoffError(
      "unknown_config",
      `configuration "${configId}" is not in the preflight report`,
      `Known configurations: ${report.configs.map((c) => c.configId).join(", ")}.`,
    );
  }
  if (config.runnable) return;

  const lines = config.blockers.map((b) => `  - [${b.kind}] ${b.detail}\n    fix: ${b.remediation}`);
  throw new BakeoffError(
    config.blockers.some((b) => b.kind === "missing_credential")
      ? "missing_credential"
      : "unknown_model_price",
    `configuration ${configId} (${config.label}) is blocked:\n${lines.join("\n")}`,
    "Clear every blocker above, then re-run preflight. Do not skip the configuration: a silently " +
      "skipped configuration turns a five-arm experiment into a four-arm one without saying so.",
  );
}

/* -------------------------------------------------------------------------
 * Human-readable report
 * ---------------------------------------------------------------------- */

const STATUS_LABEL: Readonly<Record<ConfigStatus, string>> = {
  ready: "READY",
  ready_with_assumptions: "READY (assumed pricing)",
  blocked: "BLOCKED",
};

/**
 * Format the report for a terminal.
 *
 * Contains variable NAMES and problem codes only — never a value, never a
 * prefix, never a length. Env names are printed in brackets rather than in
 * `NAME: value` form so that nothing downstream can mistake the line for an
 * assignment.
 */
export function formatPreflightReport(report: PreflightReport): string {
  const out: string[] = [];
  out.push("bakeoff preflight");
  out.push(`  generated: ${report.generatedAt}`);
  out.push(`  prices resolved for: ${report.pricedAt}`);
  out.push("");

  for (const config of report.configs) {
    out.push(`config ${config.configId} (${config.label}) — ${STATUS_LABEL[config.status]}`);
    for (const seat of config.seats) {
      const cred = seat.credential.present
        ? `${seat.credential.envName} [present]`
        : `${seat.credential.envName} [${seat.credential.problem ?? "unusable"}]`;
      const price = seat.pricing.priced
        ? seat.pricing.assumedFields.length > 0
          ? `priced (assumed: ${seat.pricing.assumedFields.join(",")})`
          : "priced"
        : "UNPRICED";
      out.push(
        `    ${seat.role.padEnd(12)} ${seat.provider}/${seat.modelId} ` +
          `effort=${seat.effort} (${seat.effortSource}) | ${cred} | ${price}`,
      );
    }
    for (const blocker of config.blockers) {
      out.push(`    BLOCKER [${blocker.kind}] ${blocker.detail}`);
      out.push(`            fix: ${blocker.remediation}`);
    }
    for (const warning of config.warnings) {
      out.push(`    warning [${warning.kind}] ${warning.detail}`);
    }
    out.push("");
  }

  out.push(`runnable: ${report.runnableConfigIds.join(", ") || "(none)"}`);
  out.push(`blocked:  ${report.blockedConfigIds.join(", ") || "(none)"}`);
  if (report.missingEnvNames.length > 0) {
    out.push("");
    out.push("missing credential variables (names only):");
    for (const name of report.missingEnvNames) out.push(`  - ${name}`);
    out.push("");
    out.push("Set them in the environment; see .env.example. Never paste a key into a chat transcript.");
  }
  return out.join("\n");
}
