/**
 * internal.ts — plumbing shared by the two subscription adapters.
 *
 * NOT PART OF THE CONTRACT. `types.ts` is the contract; this is the code both
 * adapters would otherwise duplicate: defensive readers for untyped SDK
 * payloads, the redaction wrapper, and a small CLI-probe runner.
 *
 * It exists as a sixth file rather than being copied into `claude-agent.ts` and
 * `codex.ts` because the duplicated half would be the SECURITY half — the
 * redaction wrapper and the child-environment sanitiser. Two copies of a
 * redaction call site is two places to forget one.
 */

import { execFile } from "node:child_process";
import { redactForPersistence } from "../redact.js";

/** Longest single string this module will keep. Provider output can be huge. */
export const MAX_KEPT_TEXT_CHARS = 64_000;

/** Default timeout for a local CLI status probe. Generous; it is a local read. */
export const CLI_PROBE_TIMEOUT_MS = 20_000;

/** ISO-8601 instant on the host clock. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * THE REDACTION CHOKEPOINT FOR THIS MODULE.
 *
 * Every string of PROVIDER OUTPUT that reaches an event goes through here:
 * assistant prose, reasoning summaries, command output, stderr tails, error
 * messages. `src/redact.ts` is the harness-wide chokepoint and this is simply
 * its call site, plus a length cap.
 *
 * Structural identifiers — session ids, model ids, file paths — are NOT routed
 * through it. That is deliberate and safe in both directions: the entropy rule
 * requires mixed case AND a digit specifically so that lowercase-hex ids and
 * UUIDs survive (see CREDENTIAL_RULES.HIGH_ENTROPY_TOKEN), and a redacted
 * session id would silently destroy the ability to resume — which is the one
 * capability this whole module exists to protect.
 */
export function safeText(value: string, limit: number = MAX_KEPT_TEXT_CHARS): string {
  const redacted = redactForPersistence(value);
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit)}\n…[truncated ${redacted.length - limit} chars]`;
}

/** Narrow an untyped SDK payload to a record, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Read a string field, or null when absent or the wrong type. */
export function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Read a finite number field, or null. NEVER coerces a missing field to 0. */
export function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read a boolean field, or null. */
export function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

/** Read an array of strings, dropping non-strings. Returns [] when absent. */
export function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * A message for an unknown thrown value, redacted, with no stack trace.
 *
 * A stack trace in the dashboard is the failure mode this module is written to
 * avoid, so it is dropped here rather than at each call site.
 */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name === "Error" ? "" : `${error.name}: `;
    return safeText(`${name}${error.message}`);
  }
  if (typeof error === "string") return safeText(error);
  return "an unknown error with no message";
}

/** True when a thrown value is an abort caused by our own AbortController. */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /\baborted\b/i.test(error.message);
}

/**
 * Build the environment for the spawned CLI.
 *
 * `strip` NAMES ARE REMOVED LAST, AFTER the caller's overrides are merged, so
 * an override cannot re-introduce one. That ordering is the whole point of the
 * function: each adapter strips the variables that would divert its CLI off the
 * personal subscription and on to a BILLED account. See the call sites — both
 * document exactly which variable does that and how it was verified.
 *
 * No value is logged, hashed or length-reported here; this returns an object
 * that goes straight to `spawn`.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> | null,
  strip: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  if (overrides !== null) {
    for (const [key, value] of Object.entries(overrides)) env[key] = value;
  }
  for (const name of strip) delete env[name];
  return env;
}

/** Outcome of a local CLI probe. Never throws; a spawn failure is reported. */
export interface CliProbeResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Non-null when the binary could not be spawned at all (not on PATH, etc). */
  readonly spawnProblem: string | null;
}

/**
 * Run a local CLI status command and capture its output.
 *
 * Used only for auth probes, which are local reads of a credential store: they
 * consume NO QUOTA and cost nothing. That is why `authStatus()` can be called
 * freely by a dashboard poll, and why it does not go through the SDK — the SDK
 * path would have to attempt a real API call, and this module's own measurement
 * of that path was a ~20-second storm of ten retried 401s.
 */
export function runCliProbe(
  file: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number = CLI_PROBE_TIMEOUT_MS,
): Promise<CliProbeResult> {
  return new Promise<CliProbeResult>((resolve) => {
    execFile(
      file,
      [...args],
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const err = typeof stderr === "string" ? stderr : "";
        if (error === null) {
          resolve({ ok: true, exitCode: 0, stdout: out, stderr: err, spawnProblem: null });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
        // ENOENT / EACCES mean the binary is not usable at all, which is a
        // different verdict from "it ran and said no". Kept apart on purpose:
        // one is "install the CLI", the other is "log in".
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
          resolve({
            ok: false,
            exitCode: null,
            stdout: out,
            stderr: err,
            spawnProblem: `the "${file}" command is not runnable on this machine (${String(code)})`,
          });
          return;
        }
        const exitCode = typeof code === "number" ? code : null;
        resolve({
          ok: false,
          exitCode,
          stdout: out,
          stderr: err,
          spawnProblem: exitCode === null ? describeThrown(error) : null,
        });
      },
    );
  });
}

/**
 * Merge a newly reported usage field into an accumulated one.
 *
 * `null` NEVER OVERWRITES A NUMBER: a later payload that omits a field has not
 * retracted the earlier count. And a number never becomes 0 by omission, which
 * is the same rule `ProviderAdapter.normalizeUsage` enforces by throwing.
 */
export function mergeUsageField(previous: number | null, next: number | null): number | null {
  return next ?? previous;
}
