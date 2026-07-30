/**
 * code-tree.ts — the flat `CodeTreeEntry[]` the server sends, turned into the
 * nested shape a sidebar renders, plus the two small facts the viewer needs.
 *
 * WHY THE NESTING IS THE CLIENT'S JOB. The server sends one flat list because
 * that is the shape a security check reads: every entry is a path it has already
 * decided may be served, with no parent/child relationship to get wrong. Which
 * folders are OPEN is a fact about this browser tab and about nothing else, so
 * the tree that has open/closed state is built here, from the flat list, on every
 * render. There is no second source of truth about what the workspace contains.
 *
 * PURE FUNCTIONS, NO REACT. `tests/code-tree.unit.spec.ts` runs them with no
 * browser and no dev server; a nesting bug is a bug in these functions and is
 * caught there rather than by looking at a screenshot.
 *
 * ONE INVARIANT WORTH STATING: a directory's children are ordered exactly as the
 * server ordered them (directories first, then files, each alphabetical). The
 * builder writes files in whatever order it likes and a sidebar whose rows move
 * between polls is unreadable, so the order is decided once, server-side, and
 * this module preserves it rather than re-sorting.
 */

import type { CodeTreeEntry } from "./api-types";

export interface CodeNode {
  readonly entry: CodeTreeEntry;
  /** Empty for a file. For a directory: its children, in server order. */
  readonly children: readonly CodeNode[];
  /** How many separators are above this node. Root entries are 0. */
  readonly depth: number;
}

/**
 * Build the forest.
 *
 * ROBUST TO A MISSING PARENT ROW ON PURPOSE. The server always sends the
 * directory before its contents, but the tree is also TRUNCATABLE at the entry
 * cap — and a child whose parent row is absent must still appear rather than
 * vanish into a silently dropped branch. Such a node is attached at the root, so
 * the worst case is a row shown at the wrong indent instead of a file the reader
 * cannot see.
 */
export function buildCodeTree(entries: readonly CodeTreeEntry[]): readonly CodeNode[] {
  const children = new Map<string, CodeTreeEntry[]>();
  const known = new Set(entries.map((entry) => entry.path));

  for (const entry of entries) {
    const cut = entry.path.lastIndexOf("/");
    const parent = cut === -1 ? "" : entry.path.slice(0, cut);
    const key = parent !== "" && known.has(parent) ? parent : "";
    const bucket = children.get(key);
    if (bucket === undefined) children.set(key, [entry]);
    else bucket.push(entry);
  }

  const build = (parent: string, depth: number): readonly CodeNode[] =>
    (children.get(parent) ?? []).map((entry) => ({
      entry,
      children: entry.type === "dir" ? build(entry.path, depth + 1) : [],
      depth,
    }));

  return build("", 0);
}

/**
 * Every directory on the way to `path`, outermost first.
 *
 * Used to open the folders around a file that was selected from somewhere other
 * than the tree — a deep-linked path, or the file the viewer restores after a
 * poll. `a/b/c.txt` gives `["a", "a/b"]`.
 */
export function ancestorDirs(path: string): readonly string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    out.push(parts.slice(0, index + 1).join("/"));
  }
  return out;
}

/**
 * Which directories a fresh tree should start open.
 *
 * The workspace root only. Opening everything on a run with a `node_modules`-
 * sized branch is a wall of rows; opening nothing means the panel looks empty
 * until you click. Root-level directories are the compromise, and the reader's
 * own toggles win from then on.
 */
export function initiallyOpen(entries: readonly CodeTreeEntry[]): readonly string[] {
  return entries
    .filter((entry) => entry.type === "dir" && !entry.path.includes("/"))
    .map((entry) => entry.path);
}

/**
 * The first file worth showing, or `null`.
 *
 * PREFERS A ROOT-LEVEL SOURCE FILE, because that is what a static build actually
 * produces and what the reader almost always wants first: `index.html` over
 * `assets/hero.jpg`. Falls back to the first file at any depth so a workspace
 * with no root files still opens with something on screen. Never a directory.
 */
export function firstInterestingFile(entries: readonly CodeTreeEntry[]): string | null {
  const files = entries.filter((entry) => entry.type === "file");
  const preferred = ["index.html", "index.htm", "README.md", "index.js", "index.ts"];
  for (const name of preferred) {
    const hit = files.find((entry) => entry.path === name);
    if (hit !== undefined) return hit.path;
  }
  const shallow = files.find((entry) => !entry.path.includes("/"));
  return shallow?.path ?? files[0]?.path ?? null;
}

/**
 * `804 B`, `5.6 KB`, `10 KB`, `11.8 MB`. Binary units, because file sizes are.
 *
 * ROUNDED BEFORE THE DIGIT COUNT IS CHOSEN, which is not fussiness: 10,212 bytes
 * is 9.97 KB, so deciding "under ten, show a decimal" from the unrounded value
 * prints `10.0 KB` — a number with a decimal place that is only there because the
 * threshold was tested against a different number than the one displayed.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = Math.round((bytes / 1024) * 10) / 10;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
  return `${(Math.round((kb / 1024) * 10) / 10).toFixed(1)} MB`;
}

/**
 * The language tag shown on the file's eyebrow.
 *
 * A LABEL, NOT A HIGHLIGHTER. Syntax highlighting was considered and rejected:
 * every option is a bundle measured in hundreds of kilobytes for a panel that
 * shows one file at a time, and monospace with a line-number gutter is a better
 * read than a 300 KB dependency. The extension is the honest amount of language
 * awareness this viewer has.
 */
export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.startsWith(".") ? "config" : "text";
  const ext = name.slice(dot + 1).toLowerCase();
  const named: Readonly<Record<string, string>> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    md: "markdown",
    html: "html",
    htm: "html",
    css: "css",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    py: "python",
    svg: "svg",
    txt: "text",
  };
  return named[ext] ?? ext;
}
