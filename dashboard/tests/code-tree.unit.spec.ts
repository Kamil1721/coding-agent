/**
 * The flat-to-nested transform the code sidebar renders, and the three ways it
 * can fail without anything on screen looking broken.
 *
 * FAILURE ONE: A CHILD ATTACHED TO THE WRONG PARENT. `a/b` and `ab/c` share a
 * prefix; a `startsWith` implementation nests the second under the first and the
 * reader sees a file inside a directory that does not contain it. Nothing errors.
 *
 * FAILURE TWO: A CHILD WHOSE PARENT ROW IS MISSING VANISHES. The server's tree
 * response is TRUNCATABLE at its entry cap, so a parent row genuinely can be
 * absent — and a transform that only attaches to known parents drops that whole
 * branch silently. The reader cannot tell a filtered workspace from an empty one,
 * which is the same defect class as a gate that cannot run being reported as a
 * gate that passed.
 *
 * FAILURE THREE: RE-SORTING. The server orders entries directories-first then
 * alphabetically, once, so that a poll cannot reshuffle the sidebar under the
 * cursor. A client that sorts again is a second source of truth about order, and
 * the two only have to disagree once.
 *
 * No browser: these are pure functions of their arguments.
 */

import { expect, test } from "@playwright/test";

import type { CodeTreeEntry } from "../src/lib/api-types";
import {
  ancestorDirs,
  buildCodeTree,
  firstInterestingFile,
  formatBytes,
  initiallyOpen,
  languageOf,
} from "../src/lib/code-tree";

function dir(path: string): CodeTreeEntry {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), type: "dir", bytes: null };
}

function file(path: string, bytes = 10): CodeTreeEntry {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), type: "file", bytes };
}

/** The real workspace's shape, in the order the server sends it. */
const WORKSPACE: readonly CodeTreeEntry[] = [
  dir("assets"),
  file("assets/hero-workshop.jpg", 120_000),
  dir("design-refs"),
  file("design-refs/manifest.json", 900),
  dir("visible-acceptance"),
  file("visible-acceptance/coglane-page.spec.mjs", 4_000),
  file("TICKET.md", 804),
  file("index.html", 5_763),
  file("script.js", 1_959),
  file("styles.css", 10_212),
];

test("the tree nests by path segment, not by string prefix", () => {
  const entries = [dir("a"), file("a/one.txt"), dir("ab"), file("ab/two.txt")];
  const nodes = buildCodeTree(entries);

  expect(nodes.map((node) => node.entry.path)).toEqual(["a", "ab"]);
  const a = nodes[0];
  const ab = nodes[1];
  expect(a?.children.map((child) => child.entry.path)).toEqual(["a/one.txt"]);
  // THE DISCRIMINATING ASSERTION. `"ab/two.txt".startsWith("a")` is true, so a
  // prefix-based transform puts this file under `a/` and the reader is shown a
  // lie about where it lives.
  expect(ab?.children.map((child) => child.entry.path)).toEqual(["ab/two.txt"]);
});

test("depth is the indent, and it counts separators", () => {
  const nodes = buildCodeTree([dir("a"), dir("a/b"), file("a/b/c.txt")]);
  const a = nodes[0];
  const b = a?.children[0];
  const c = b?.children[0];
  expect(a?.depth).toBe(0);
  expect(b?.depth).toBe(1);
  expect(c?.depth).toBe(2);
  expect(c?.entry.name).toBe("c.txt");
});

test("a child whose parent row was truncated away is still shown", () => {
  // `deep/` never arrived — the entry cap cut it. The file must not disappear.
  const nodes = buildCodeTree([file("index.html"), file("deep/lost.txt")]);
  const paths = nodes.map((node) => node.entry.path);
  expect(paths).toContain("deep/lost.txt");
  expect(paths).toContain("index.html");
});

test("server order survives: directories first, then files, never re-sorted", () => {
  const nodes = buildCodeTree(WORKSPACE);
  expect(nodes.map((node) => node.entry.path)).toEqual([
    "assets",
    "design-refs",
    "visible-acceptance",
    "TICKET.md",
    "index.html",
    "script.js",
    "styles.css",
  ]);
  // POSITIVE CONTROL for "not re-sorted": `TICKET.md` sorts before `index.html`
  // only under the server's byte order, and a client that lower-cased or
  // localeCompare'd would swap them.
  expect(nodes[3]?.entry.name).toBe("TICKET.md");
});

test("the panel opens on the file a reader wants, and only the root folders", () => {
  expect(firstInterestingFile(WORKSPACE)).toBe("index.html");
  expect(initiallyOpen(WORKSPACE)).toEqual(["assets", "design-refs", "visible-acceptance"]);

  // No index.html: the first ROOT-LEVEL file wins over a deeper one, because a
  // build's own source sits at the root and its assets do not.
  const noIndex = [dir("assets"), file("assets/a.png"), file("main.js")];
  expect(firstInterestingFile(noIndex)).toBe("main.js");

  // Nothing at the root at all: still opens something rather than nothing.
  expect(firstInterestingFile([dir("src"), file("src/app.ts")])).toBe("src/app.ts");

  // No files whatsoever is null, NOT a directory — selecting a directory would
  // fetch `?path=<dir>` and render the server's 400.
  expect(firstInterestingFile([dir("empty")])).toBeNull();
});

test("ancestorDirs opens the folders around a deep file", () => {
  expect(ancestorDirs("a/b/c.txt")).toEqual(["a", "a/b"]);
  expect(ancestorDirs("index.html")).toEqual([]);
});

test("sizes and language labels read the way a file listing should", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(804)).toBe("804 B");
  expect(formatBytes(10_212)).toBe("10 KB");
  expect(formatBytes(5_763)).toBe("5.6 KB");
  expect(formatBytes(12_369_476)).toBe("11.8 MB");

  expect(languageOf("visible-acceptance/coglane-page.spec.mjs")).toBe("javascript");
  expect(languageOf("styles.css")).toBe("css");
  expect(languageOf("TICKET.md")).toBe("markdown");
  // A dotfile has no extension and is not "text": it is configuration, and
  // calling it `md` because of a dot in the middle would be worse than silence.
  expect(languageOf(".gitignore")).toBe("config");
  expect(languageOf("Makefile")).toBe("text");
});
