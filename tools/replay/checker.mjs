/**
 * THE CHECKER UNDER REPLAY — loaded LIVE from the built bakeoff package.
 *
 * Deliberately NOT vendored. A vendored copy of `parseSuiteManifest` would turn
 * this harness into a museum: it would keep agreeing with the validator of the
 * day it was copied, which is the exact shape of a check that can only observe
 * success. The point of checker replay (RESEARCH H1(a)) is "stored artefacts ×
 * CANDIDATE checker", so the checker must be whatever is on disk right now.
 *
 * IDENTITY IS RECORDED WITH EVERY RESULT. `bakeoff/dist` is a build output that
 * a concurrent lane can rebuild underneath this process, and `dist/spec-agent.js`
 * was already measurably stale against its source while this was written. A
 * replay result without checker identity is unattributable, so every report
 * carries the module path, mtime, size and sha256 of the file that actually ran.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_CHECKER = path.join(REPO_ROOT, "bakeoff", "dist", "scorer-protocol.js");

/** The command that repairs a missing/stale checker, quoted in every failure. */
export const BUILD_HINT = "cd bakeoff && npx tsc -p tsconfig.json";

export function fileIdentity(file) {
  const st = statSync(file);
  return {
    path: path.relative(REPO_ROOT, file),
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

/**
 * Load a checker. `override` lets a test point this at a stub — which is how the
 * arm check below is proved able to fail (see replay.test.mjs).
 */
export async function loadChecker(override = process.env.REPLAY_CHECKER ?? DEFAULT_CHECKER) {
  const file = path.resolve(override);
  if (!existsSync(file)) {
    throw new Error(`checker module not found: ${file}\n  build it with: ${BUILD_HINT}`);
  }
  const mod = await import(pathToFileURL(file).href);
  for (const name of ["parseSuiteManifest", "collectManifestProblems"]) {
    if (typeof mod[name] !== "function") {
      throw new Error(`checker module ${file} does not export ${name}()\n  build it with: ${BUILD_HINT}`);
    }
  }
  return {
    identity: fileIdentity(file),
    parseSuiteManifest: mod.parseSuiteManifest,
    collectManifestProblems: mod.collectManifestProblems,
  };
}

/**
 * Run one manifest through both readers of the real validator.
 *
 * `failFast` is what `parseSuiteManifest` says — the sentence the container and
 * the audit actually saw on 2026-08-09, one field at a time. `collectAll` is what
 * `collectManifestProblems` says — the whole survey. Reporting both is the point:
 * the gap between them is the measurement that explains why three attempts could
 * not converge (post-mortem §HOW IT DIED: "Discovery one field at a time in three
 * tries is arithmetically impossible").
 */
export function checkManifest(checker, manifest) {
  let accepted = false;
  let failFast = null;
  try {
    checker.parseSuiteManifest(manifest);
    accepted = true;
  } catch (err) {
    failFast = err instanceof Error ? err.message : String(err);
  }
  const problems = checker.collectManifestProblems(manifest);
  return {
    accepted,
    failFast,
    collectAll: problems.map((p) => ({ field: p.field, message: p.message, remediation: p.remediation })),
    collectAllFields: [...new Set(problems.map((p) => p.field))].sort(),
  };
}

/**
 * A manifest that the real parser MUST accept, and the malformation of it that
 * the real parser MUST reject. Used by the arm check. The populated
 * `dataExpectations` entry is `bakeoff/docker/README.md:391` verbatim — the one
 * correct example that existed in the repository on the night of the failure,
 * in a file the seat never read.
 */
export const KNOWN_GOOD_MANIFEST = Object.freeze({
  manifestVersion: 1,
  ticketId: "t-armcheck",
  target: "web",
  execution: {
    install: "npm ci",
    build: null,
    typecheck: null,
    lint: null,
    start: "npm start",
    port: 3000,
    healthPath: "/api/health",
    bootTimeoutMs: null,
    commandTimeoutMs: null,
  },
  sourceDirs: ["src"],
  uiFlows: [],
  dataExpectations: [
    { id: "db-query-7", kind: "sqlite", file: "data/app.db", table: "bookings", sql: null, path: null, minRows: 1 },
    { id: "api-count-1", kind: "http", file: null, table: null, sql: null, path: "/api/bookings", minRows: 1 },
  ],
});

/**
 * The malformation the arm check demands be REJECTED BY NAME. Dropping `minRows`
 * is the field NO attempt on 2026-08-09 ever emitted and none was ever told about
 * (post-mortem: `grep -ac "minRows" bakeoff/src/spec-agent.ts` → 0).
 */
export function knownBadManifest() {
  const bad = structuredClone(KNOWN_GOOD_MANIFEST);
  delete bad.dataExpectations[0].minRows;
  return bad;
}
export const KNOWN_BAD_EXPECTED_FIELD = "dataExpectations[0].minRows";
