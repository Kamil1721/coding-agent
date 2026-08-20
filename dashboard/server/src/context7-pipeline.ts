/** Host-owned scope compilation and bounded source capture for code review. */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { extname, join } from "node:path";

import { isCanonicalContext7Package } from "./context7-review.js";
import type { ExternalReviewClaim, ReviewClaim, ReviewScope } from "./context7-review.js";
import { denyReason, isRefusal, readWorkspaceFile, readWorkspaceTree, resolveWorkspacePath } from "./code-files.js";
import { isReviewPackageName, reviewVersionOrNull } from "./review-claims.js";

export const CONTEXT7_PILOT_PROJECT_ID = "coding-agent";
export const MAX_CONTEXT7_SOURCE_BYTES = 384 * 1024;
export const MAX_CONTEXT7_SOURCE_FILES = 80;
export const MAX_CONTEXT7_SOURCE_FILE_BYTES = 64 * 1024;
export const MAX_CONTEXT7_MANIFEST_BYTES = 256 * 1024;
export const MAX_CONTEXT7_PACKAGE_NAME_CHARS = 214;
export const MAX_CONTEXT7_EXTERNAL_CLAIMS = 8;

export type Context7ScopeFailure = "scope_unavailable" | null;
export interface Context7CompiledReviewScope extends ReviewScope {
  readonly scopeFailure: Context7ScopeFailure;
}

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".scss",
  ".ts",
  ".tsx",
  ".vue",
]);
const SOURCE_BASENAMES = new Set(["Dockerfile", "package.json"]);
const EXCLUDED_SEGMENTS = new Set([
  ".bakeoff",
  ".design-tmp",
  ".git",
  ".next",
  "build",
  "coverage",
  "design-refs",
  "dist",
  "node_modules",
  "visible-acceptance",
]);
const EXCLUDED_FILES = /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/u;
export interface Context7SourceSnapshot {
  readonly text: string;
  readonly sourceHash: string;
  readonly files: readonly string[];
  readonly bytes: number;
  readonly truncated: boolean;
}

function digestFile(hash: ReturnType<typeof createHash>, target: string): number | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(target, "r");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      total += count;
    }
    return total;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sliceUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Do not end between UTF-16 surrogate halves. Besides producing malformed
  // prompt text, the replacement character could move the result over the byte
  // ceiling this helper promises.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? "")) low -= 1;
  return value.slice(0, low);
}

interface ManifestDependency {
  readonly package: string;
  readonly versionOrRange: string;
}

function packageRoot(reference: string): string | null {
  const value = reference.trim();
  if (value.startsWith("node:") || /^https?:/iu.test(value)) return "!unsupported";
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("#")) return null;
  const segments = value.split("/");
  return value.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0] ?? null;
}

function sourceUsage(workspace: string, runId: string, entries: readonly { readonly type: string; readonly path: string }[]): {
  readonly packages: ReadonlySet<string>;
  readonly failed: boolean;
} {
  const packages = new Set<string>();
  let failed = false;
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /@import\s+(?:url\()?\s*["']([^"']+)["']/gu,
  ];
  for (const entry of entries) {
    if (entry.type !== "file" || !sourceCandidate(entry.path) || entry.path.endsWith("package.json")) continue;
    const resolved = resolveWorkspacePath(workspace, entry.path);
    if (!resolved.ok) { failed = true; continue; }
    const file = readWorkspaceFile(resolved.target, entry.path, runId);
    if (isRefusal(file) || file.text === null || file.truncated) { failed = true; continue; }
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of file.text.matchAll(pattern)) {
        const root = packageRoot(match[1] ?? "");
        if (root === "!unsupported") failed = true;
        else if (root !== null && root.length > 0) packages.add(root);
      }
    }
    if (/^vite\.config\./u.test(entry.path)) packages.add("vite");
    if (/^tailwind\.config\./u.test(entry.path)) packages.add("tailwindcss");
    if (/^playwright\.config\./u.test(entry.path)) packages.add("@playwright/test");
    if (/^next\.config\./u.test(entry.path)) packages.add("next");
  }
  return { packages, failed };
}

function scriptUsesPackage(scripts: readonly string[], packageName: string): boolean {
  const knownBins: Readonly<Record<string, readonly string[]>> = {
    "@playwright/test": ["playwright"],
    tailwindcss: ["tailwindcss"],
  };
  const basename = packageName.split("/").at(-1) ?? packageName;
  const bins = knownBins[packageName] ?? [basename];
  return scripts.some((script) => bins.some((bin) => new RegExp(`(?:^|[;&|\\s])${bin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|\\s)`, "u").test(script)));
}

function manifestDependencies(workspace: string, runId: string): {
  readonly dependencies: readonly ManifestDependency[];
  readonly failed: boolean;
} {
  const tree = readWorkspaceTree(workspace, runId);
  if (isRefusal(tree) || tree.truncated) return { dependencies: [], failed: true };
  const manifests = tree.entries
    .filter((entry) => entry.type === "file" && (entry.path === "package.json" || entry.path.endsWith("/package.json")))
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b));
  if (tree.exclusions.some((entry) => exclusionCouldHideReviewSource(workspace, entry))) {
    return { dependencies: [], failed: true };
  }
  const unsupportedEcosystem = tree.entries.some(
    (entry) => entry.type === "file" && /(?:^|\/)(?:pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|composer\.json)$/u.test(entry.path),
  );
  if (unsupportedEcosystem) return { dependencies: [], failed: true };
  const usage = sourceUsage(workspace, runId, tree.entries);
  const rows: { readonly package: string; readonly version: string; readonly dev: boolean }[] = [];
  const localPackages = new Set<string>();
  const scripts: string[] = [];
  for (const path of manifests) {
    const resolved = resolveWorkspacePath(workspace, path);
    if (!resolved.ok) return { dependencies: [], failed: true };
    const file = readWorkspaceFile(resolved.target, path, runId);
    if (isRefusal(file) || file.text === null || file.truncated || Buffer.byteLength(file.text, "utf8") > MAX_CONTEXT7_MANIFEST_BYTES) {
      return { dependencies: [], failed: true };
    }
    let root: unknown;
    try { root = JSON.parse(file.text); } catch { return { dependencies: [], failed: true }; }
    if (typeof root !== "object" || root === null || Array.isArray(root)) return { dependencies: [], failed: true };
    const record = root as Record<string, unknown>;
    if (typeof record["name"] === "string" && isReviewPackageName(record["name"])) localPackages.add(record["name"]);
    const rawScripts = record["scripts"];
    if (rawScripts !== undefined) {
      if (typeof rawScripts !== "object" || rawScripts === null || Array.isArray(rawScripts)) return { dependencies: [], failed: true };
      for (const value of Object.values(rawScripts as Record<string, unknown>)) {
        if (typeof value !== "string") return { dependencies: [], failed: true };
        scripts.push(value);
      }
    }
    for (const key of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"] as const) {
      const raw = record[key];
      if (raw === undefined) continue;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { dependencies: [], failed: true };
      for (const [packageName, version] of Object.entries(raw as Record<string, unknown>)) {
        if (!isReviewPackageName(packageName) || packageName.length > MAX_CONTEXT7_PACKAGE_NAME_CHARS || typeof version !== "string") {
          return { dependencies: [], failed: true };
        }
        rows.push({ package: packageName, version, dev: key === "devDependencies" });
      }
    }
  }
  const versions = new Map<string, string>();
  for (const row of rows) {
    if (localPackages.has(row.package) || /^(?:workspace|file|link):/u.test(row.version)) continue;
    if (row.dev && (!isCanonicalContext7Package(row.package) || (!usage.packages.has(row.package) && !scriptUsesPackage(scripts, row.package)))) continue;
    const supported = reviewVersionOrNull(row.version);
    if (supported === null) return { dependencies: [], failed: true };
    const previous = versions.get(row.package);
    if (previous !== undefined && previous !== supported) return { dependencies: [], failed: true };
    versions.set(row.package, supported);
  }
  const dependencies = [...versions].map(([packageName, versionOrRange]) => ({ package: packageName, versionOrRange }));
  return { dependencies, failed: usage.failed || dependencies.length > MAX_CONTEXT7_EXTERNAL_CLAIMS };
}

function fixedPurpose(packageName: string): string {
  return `Verify current public usage, configuration, version compatibility, and deprecations for ${packageName} as used by the supplied source.`;
}

/** Finished fenced manifests define runtime and corroborated development scope. */
export function compileContext7ReviewScope(input: {
  readonly projectId: string;
  readonly workspace: string;
  readonly runId?: string;
}): Context7CompiledReviewScope {
  const manifest = manifestDependencies(input.workspace, input.runId ?? "context7-scope");
  const byPackage = new Map<string, ManifestDependency>();
  for (const claim of manifest.dependencies) byPackage.set(claim.package, claim);

  const external: ExternalReviewClaim[] = [...byPackage.values()]
    .sort((left, right) => left.package.localeCompare(right.package))
    .map((claim, index) => ({
      kind: "external",
      id: `EC-${String(index + 1)}`,
      package: claim.package,
      versionOrRange: claim.versionOrRange,
      queryPurpose: fixedPurpose(claim.package),
    }));
  const claims: readonly ReviewClaim[] =
    external.length > 0
      ? external
      : [{ kind: "internal", id: "IC-1", subject: "Repository-internal logic, copy, layout, and conventions." }];
  return { projectId: input.projectId, claims, scopeFailure: manifest.failed ? "scope_unavailable" : null };
}

function sourceCandidate(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  const basename = segments.at(-1) ?? "";
  if (EXCLUDED_FILES.test(basename)) return false;
  return SOURCE_BASENAMES.has(basename) || SOURCE_EXTENSIONS.has(extname(basename).toLowerCase());
}

function exclusionCouldHideReviewSource(
  workspace: string,
  entry: { readonly path: string; readonly reason: string },
): boolean {
  const segments = entry.path.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  const basename = segments.at(-1) ?? "";
  if (EXCLUDED_FILES.test(basename)) return false;
  let excluded;
  try {
    excluded = lstatSync(join(workspace, ...segments));
  } catch {
    return true;
  }
  if (excluded.isDirectory() || !excluded.isFile()) return true;
  if (sourceCandidate(entry.path)) return true;
  return denyReason(entry.path) === null;
}

/**
 * Capture only redacted, browser-readable source through the existing workspace
 * fence. The same symlink, secret-name and containment rules therefore protect
 * the review seat and the owner's code browser.
 */
export function captureContext7ReviewSource(workspace: string, runId: string): Context7SourceSnapshot {
  const tree = readWorkspaceTree(workspace, runId);
  if (isRefusal(tree)) {
    const text = "No readable source files were available for independent review.";
    return { text, sourceHash: sha256(`unavailable:${tree.code}`), files: [], bytes: Buffer.byteLength(text), truncated: true };
  }

  const candidates = tree.entries
    .filter((entry) => entry.type === "file" && sourceCandidate(entry.path))
    .map((entry) => entry.path)
    .sort((left, right) => {
      if (left === "package.json") return -1;
      if (right === "package.json") return 1;
      return left.localeCompare(right);
    });
  const parts: string[] = [];
  const freshness = createHash("sha256");
  const files: string[] = [];
  let bytes = 0;
  let truncated =
    tree.truncated ||
    candidates.length > MAX_CONTEXT7_SOURCE_FILES ||
    tree.exclusions.some((entry) => exclusionCouldHideReviewSource(workspace, entry));
  for (const path of candidates) {
    const resolved = resolveWorkspacePath(workspace, path);
    freshness.update(path, "utf8").update("\0", "utf8");
    if (!resolved.ok) {
      truncated = true;
      freshness.update(`refused:${resolved.refusal.code}\0`, "utf8");
      continue;
    }
    const file = readWorkspaceFile(resolved.target, path, runId);
    if (isRefusal(file) || file.text === null) {
      truncated = true;
      freshness.update("unreadable\0", "utf8");
      continue;
    }
    const fileHash = createHash("sha256");
    const rawBytes = digestFile(fileHash, resolved.target);
    if (rawBytes === null) {
      truncated = true;
      freshness.update("unreadable-raw\0", "utf8");
    } else {
      freshness.update(String(rawBytes), "utf8").update("\0", "utf8").update(fileHash.digest()).update("\0", "utf8");
    }
    if (file.truncated) truncated = true;
    if (files.length >= MAX_CONTEXT7_SOURCE_FILES) continue;
    const body = sliceUtf8(file.text, MAX_CONTEXT7_SOURCE_FILE_BYTES);
    const part = `--- ${path} ---\n${body}`;
    const partBytes = Buffer.byteLength(part, "utf8");
    const separatorBytes = parts.length === 0 ? 0 : 2;
    if (bytes + separatorBytes + partBytes > MAX_CONTEXT7_SOURCE_BYTES) {
      truncated = true;
      continue;
    }
    if (file.truncated || body.length < file.text.length) truncated = true;
    parts.push(part);
    files.push(path);
    bytes += separatorBytes + partBytes;
  }
  const text = parts.length > 0 ? parts.join("\n\n") : "No readable source files were available for independent review.";
  return { text, sourceHash: freshness.digest("hex"), files, bytes: Buffer.byteLength(text, "utf8"), truncated };
}
