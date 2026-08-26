/**
 * The only frozen-suite execution facts the builder is allowed to learn.
 *
 * The suite manifest contains held-out paths, criteria and scoring metadata.
 * None of that crosses this module. Callers receive this deliberately narrow
 * projection, derived only after the scorer's own parser has accepted the
 * manifest and its ticket identity has been checked.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  SUITE_MANIFEST_FILENAME,
  parseSuiteManifest,
  resolveExecutionPlan,
} from "bakeoff/dist/scorer-protocol.js";
import { suiteRootFor } from "bakeoff/dist/spec-freeze.js";
import { resolveStaticFile } from "bakeoff/dist/tier0.js";

export type ArtifactExecutionContract =
  | {
      readonly mode: "static";
      readonly rootDocument: "/";
    }
  | {
      readonly mode: "server";
      readonly start: string;
      readonly port: number;
      readonly healthPath: string;
    };

/** Read, validate and project the frozen manifest. Any uncertainty is fatal. */
export function loadArtifactExecutionContract(
  ticketId: string,
  acceptanceRoot: string,
): ArtifactExecutionContract {
  const manifestPath = join(suiteRootFor(ticketId, acceptanceRoot), SUITE_MANIFEST_FILENAME);
  const manifest = parseSuiteManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  if (manifest.ticketId !== ticketId) {
    throw new Error(
      `the frozen execution manifest is for ticket ${JSON.stringify(manifest.ticketId)}, ` +
        `not ${JSON.stringify(ticketId)}`,
    );
  }

  const resolved = resolveExecutionPlan(manifest.execution);
  if (resolved.mode === "static") {
    if (resolved.rootDocument !== "/") {
      throw new Error(
        `the dashboard supports only the static root document "/", got ${JSON.stringify(resolved.rootDocument)}`,
      );
    }
    return Object.freeze({ mode: "static", rootDocument: "/" });
  }

  return Object.freeze({
    mode: "server",
    start: resolved.start,
    port: resolved.port,
    healthPath: resolved.healthPath,
  });
}

/**
 * Enforce the ordinary-run artifact precondition before a sealed scorer exists.
 *
 * Server contracts are preserved exactly and left to the scorer's real boot
 * phase. Static contracts get the scorer-equivalent URL resolution plus a
 * stricter direct-file check: `/index.html` must itself be a regular non-symlink
 * file with non-whitespace content.
 */
export function assertArtifactExecutionReady(
  workspace: string,
  contract: ArtifactExecutionContract,
): void {
  if (contract.mode === "server") return;

  const resolved = resolveStaticFile(workspace, contract.rootDocument);
  const directRoot = join(workspace, "index.html");
  if (resolved === null) {
    throw new Error('STATIC execution requires "/" to resolve to workspace-root index.html');
  }

  let descriptor: number;
  try {
    descriptor = openSync(
      directRoot,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error(
      "STATIC execution requires a direct regular non-symlink workspace-root index.html",
    );
  }

  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("STATIC execution rejects a non-regular workspace-root index.html");
    }

    // Read from the same O_NOFOLLOW descriptor that was classified above. A
    // pathname read here would reopen the file after validation and reintroduce
    // a symlink/swap race. The fixed buffer also keeps a very large or sparse
    // whitespace document from becoming one equally large allocation.
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      if (/\S/u.test(decoder.write(chunk.subarray(0, bytesRead)))) return;
    }
    if (/\S/u.test(decoder.end())) return;
    throw new Error("STATIC execution requires a non-empty workspace-root index.html");
  } finally {
    closeSync(descriptor);
  }
}
