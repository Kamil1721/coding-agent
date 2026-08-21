/** Durable, isolated hand-off from a terminal run to a new run. */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import type { RunPaths } from "./paths.js";
import type { ReferenceDocument, ReferenceImage, ReferenceManifest } from "./ticket-refs.js";

const MAX_COPY_DEPTH = 64;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".next", "coverage"]);

export interface ContinuationRecord {
  readonly sourceRunId: string;
  readonly sourceMessageSeq: number;
  readonly targetRunId: string;
  readonly createdAt: string;
}

export interface ContinuationDocumentSource {
  readonly path: string;
  readonly mediaType: string;
}

export function continuationRunId(sourceRunId: string, sourceMessageSeq: number): string {
  const anchor = `${sourceRunId}\n${String(sourceMessageSeq)}`;
  return `run-cont-${createHash("sha256").update(anchor).digest("hex").slice(0, 20)}`;
}

export function continuationBrief(
  sourceBrief: string,
  sourceRunId: string,
  sourceMessageSeq: number,
  message: string,
): string {
  const request = message.length === 0 ? "The owner attached a new reference to this follow-up." : message;
  return [
    sourceBrief,
    "",
    "--- OWNER FOLLOW-UP ---",
    `Continue the existing project from terminal run ${sourceRunId}, owner message ${String(sourceMessageSeq)}.`,
    "The previous workspace is copied into this run. Preserve working behavior unless this follow-up changes it.",
    request,
  ].join("\n");
}

/**
 * Copy only authored project files. Git metadata and dependency caches are not
 * carried across identities; the new run creates its own empty baseline.
 */
export function stageContinuationWorkspace(source: RunPaths, target: RunPaths): boolean {
  try {
    if (!existsSync(source.workspace) || !statSync(source.workspace).isDirectory()) return false;
  } catch {
    return false;
  }
  // Claim the deterministic target root atomically. A concurrent replay must
  // never delete or rewrite a workspace another server has already staged.
  mkdirSync(target.root);
  try {
    mkdirSync(target.workspace);
    copyTree(source.workspace, target.workspace, 0);
    return true;
  } catch (error) {
    rmSync(target.root, { recursive: true, force: true });
    throw error;
  }
}

function copyTree(source: string, target: string, depth: number): void {
  if (depth > MAX_COPY_DEPTH) throw new Error(`continuation workspace exceeds ${String(MAX_COPY_DEPTH)} levels`);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to, depth + 1);
    } else if (entry.isFile()) {
      mkdirSync(target, { recursive: true });
      copyFileSync(from, to);
    }
  }
}

export function writeContinuationRecord(target: RunPaths, record: ContinuationRecord): void {
  mkdirSync(target.root, { recursive: true });
  writeFileSync(join(target.root, "continuation.json"), JSON.stringify(record, null, 2), "utf8");
}

/**
 * Copy every builder-facing reference into the continuation's own run tree.
 * A continuation must remain buildable if its terminal source is archived.
 */
export function copyContinuationReferences(
  source: ReferenceManifest | null,
  addedImages: readonly string[],
  addedDocuments: readonly ContinuationDocumentSource[],
  targetReferenceDir: string,
  targetDocumentDir: string,
): ReferenceManifest | null {
  if (
    source === null &&
    addedImages.length === 0 &&
    addedDocuments.length === 0
  ) return null;

  const images = [
    ...(source?.images.map((image) => image.path) ?? []),
    ...addedImages,
  ].map((path, index) => copyImage(path, targetReferenceDir, `continuation-image-${String(index + 1)}`));

  const sourceDocuments = source?.documents ?? [];
  const documents = [
    ...sourceDocuments.map((document) => ({ path: document.path, mediaType: document.mediaType })),
    ...addedDocuments,
  ].map((document, index) =>
    copyDocument(
      document,
      targetDocumentDir,
      `continuation-document-${String(index + 1)}`,
    ),
  );

  const capture = source?.capture ?? null;
  const isolatedCapture =
    capture === null
      ? null
      : {
          ...capture,
          shots: capture.shots.map((shot, index) => ({
            ...copyImage(
              shot.path,
              targetReferenceDir,
              `continuation-capture-${String(index + 1)}`,
            ),
            width: shot.width,
          })),
        };

  return {
    images,
    capture: isolatedCapture,
    documents,
    motion: source?.motion ?? null,
  };
}

function copyImage(path: string, directory: string, stem: string): ReferenceImage {
  const bytes = copyReferenceFile(path, directory, stem);
  return {
    path: bytes.path,
    sha256: createHash("sha256").update(bytes.bytes).digest("hex"),
    bytes: bytes.bytes.byteLength,
  };
}

function copyDocument(
  source: ContinuationDocumentSource,
  directory: string,
  stem: string,
): ReferenceDocument {
  return { ...copyImage(source.path, directory, stem), mediaType: source.mediaType };
}

function copyReferenceFile(
  source: string,
  directory: string,
  stem: string,
): { readonly path: string; readonly bytes: Buffer } {
  const bytes = readFileSync(source);
  const extension = extname(source).toLowerCase();
  const path = join(directory, `${stem}${extension}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, bytes);
  return { path, bytes };
}
