/**
 * hash.ts — the ONLY place a bake-off digest may be computed.
 *
 * The freeze is load-bearing. Constraint 1 of the protocol says the acceptance
 * suite is "hashed and frozen"; if the spec agent and the gate runner hash
 * different bytes, the freeze is decoration and a silently mutated suite scores
 * as a legitimate one. Every agent in this system computes digests here.
 *
 * Canonical JSON (sorted keys) additionally satisfies doc 04 section 3.3
 * item 5: non-deterministic key ordering in serialised structures produces an
 * intermittent, near-undebuggable ~0% prompt-cache hit rate.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, sep, posix } from "node:path";
import { BakeoffError } from "./contracts.js";
import type { AcceptanceCriterion, TestFileRef } from "./contracts.js";

/* -------------------------------------------------------------------------
 * Primitives
 * ---------------------------------------------------------------------- */

/** sha256, lowercase hex. Strings are hashed as raw UTF-8 bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, no locale dependence.
 *
 * Throws on anything whose serialisation is ambiguous or lossy — `undefined`,
 * functions, symbols, bigints, NaN, +/-Infinity, Date. A digest computed over a
 * value that silently dropped a field is worse than no digest.
 */
export function canonicalJson(value: JsonValue): string {
  return encode(value, []);
}

function encode(value: unknown, path: readonly string[]): string {
  const where = path.length === 0 ? "<root>" : path.join(".");

  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `canonicalJson: non-finite number at ${where}`,
          "Replace NaN/Infinity with a JSON-representable value before hashing.",
        );
      }
      // JSON.stringify already produces the shortest round-tripping form.
      return JSON.stringify(value);
    }
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new BakeoffError(
        "invalid_usage_shape",
        `canonicalJson: unsupported ${typeof value} at ${where}`,
        "Persisted records use `T | null`, never `undefined`. Convert before hashing.",
      );
    default:
      break;
  }

  if (Array.isArray(value)) {
    const parts = value.map((v, i) => encode(v, [...path, String(i)]));
    return `[${parts.join(",")}]`;
  }

  if (value instanceof Date) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `canonicalJson: Date at ${where}`,
      "Serialise instants as ISO-8601 strings before hashing so the digest is timezone-independent.",
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${encode(record[k], [...path, k])}`);
  return `{${parts.join(",")}}`;
}

/** sha256 of the canonical JSON encoding of a value. */
export function canonicalJsonDigest(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}

/* -------------------------------------------------------------------------
 * Tickets
 * ---------------------------------------------------------------------- */

/**
 * Digest of a ticket brief.
 *
 * The brief's RAW UTF-8 BYTES, with NO normalisation: no trimming, no newline
 * conversion, no Unicode normalisation, no whitespace collapsing. The ticket
 * text is frozen verbatim and never edited between runs (doc 03 section 7.1);
 * any normalisation here would let an edit pass unnoticed.
 *
 * Note that a ticket's own `sha256` field cannot cover itself: this digest is
 * over `brief` alone.
 */
export function ticketDigest(brief: string): string {
  return sha256Hex(brief);
}

/** True when a ticket's recorded digest still matches its brief. */
export function ticketDigestMatches(brief: string, recordedSha256: string): boolean {
  return ticketDigest(brief) === recordedSha256;
}

/* -------------------------------------------------------------------------
 * Files
 * ---------------------------------------------------------------------- */

function toPosixRelative(relPath: string): string {
  return relPath.split(sep).join(posix.sep);
}

/**
 * Digest one file's raw bytes. Path is recorded POSIX-relative.
 *
 * The type check uses `lstat`, so a SYMLINK IS REJECTED rather than silently
 * digested through to its target. This is in the freeze path for constraint 1:
 * a symlink inside the suite directory has a stable recorded path and unstable
 * content, which is exactly the hole a "hashed and frozen" suite must not have.
 */
export function fileDigest(rootDir: string, relPath: string): TestFileRef {
  const normalised = toPosixRelative(relPath);
  const absolute = join(rootDir, relPath);
  const stats = lstatSync(absolute);
  if (!stats.isFile()) {
    throw new BakeoffError(
      "invalid_usage_shape",
      `fileDigest: ${normalised} is not a regular file (${stats.isSymbolicLink() ? "symlink" : "not a file"})`,
      "Digest regular files only. A symlink or directory cannot be frozen by content: its recorded " +
        "path is stable while what it resolves to is not.",
    );
  }
  const bytes = readFileSync(absolute);
  return { path: normalised, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
}

/**
 * Digest a set of files, returned SORTED BY PATH so that a reordered directory
 * listing cannot change the suite digest.
 */
export function digestFileSet(rootDir: string, relPaths: readonly string[]): readonly TestFileRef[] {
  return relPaths
    .map((p) => fileDigest(rootDir, p))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* -------------------------------------------------------------------------
 * The acceptance-suite freeze digest
 * ---------------------------------------------------------------------- */

/** Inputs to the suite freeze digest. */
export interface AcceptanceSuiteDigestInput {
  readonly ticketId: string;
  readonly ticketSha256: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly testFiles: readonly TestFileRef[];
}

/**
 * THE suite freeze digest.
 *
 * Covers: ticketId, ticketSha256, the criteria (sorted by id) and the per-file
 * content digests (sorted by path).
 *
 * Deliberately does NOT cover: the suite's own `sha256`, `generatedAt`,
 * `auditPassed`, `auditFindings`, `auditedBy` or `auditedAt`. Re-running the
 * adversarial audit must not change the freeze — otherwise the digest recorded
 * in a run record would stop matching the suite that was actually executed.
 *
 * Throws on duplicate criterion ids or duplicate file paths: either makes the
 * digest ambiguous.
 */
export function acceptanceSuiteDigest(input: AcceptanceSuiteDigestInput): string {
  const criterionIds = new Set<string>();
  for (const c of input.criteria) {
    if (criterionIds.has(c.id)) {
      throw new BakeoffError(
        "suite_hash_mismatch",
        `duplicate acceptance criterion id "${c.id}" in suite for ticket ${input.ticketId}`,
        "Criterion ids must be unique and stable. Regenerate the suite with unique REQ-IDs.",
      );
    }
    criterionIds.add(c.id);
  }

  const filePaths = new Set<string>();
  for (const f of input.testFiles) {
    if (filePaths.has(f.path)) {
      throw new BakeoffError(
        "suite_hash_mismatch",
        `duplicate test file path "${f.path}" in suite for ticket ${input.ticketId}`,
        "Each test file may appear once. Rebuild the file set.",
      );
    }
    filePaths.add(f.path);
  }

  const criteria = [...input.criteria]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({
      id: c.id,
      statement: c.statement,
      evidenceRequired: c.evidenceRequired,
      tier: c.tier,
    }));

  const testFiles = [...input.testFiles]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));

  return canonicalJsonDigest({
    digestVersion: 1,
    ticketId: input.ticketId,
    ticketSha256: input.ticketSha256,
    criteria,
    testFiles,
  });
}

/**
 * Verify a suite on disk still matches its freeze digest.
 *
 * Call this in the scorer, immediately before execution: it is the check that
 * makes "no builder may modify the suite" enforceable rather than aspirational.
 */
export function assertSuiteDigestMatches(
  input: AcceptanceSuiteDigestInput,
  recordedSha256: string,
): void {
  const actual = acceptanceSuiteDigest(input);
  if (actual !== recordedSha256) {
    throw new BakeoffError(
      "suite_hash_mismatch",
      `acceptance suite for ticket ${input.ticketId} has digest ${actual}, expected ${recordedSha256}`,
      "The frozen suite changed after it was sealed. Do NOT score this run. Investigate: a builder " +
        "with write access to the suite is the failure mode this gate exists to prevent " +
        "(ImpossibleBench measured Claude-family models editing test files >79% of the time).",
    );
  }
}
