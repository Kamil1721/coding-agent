/**
 * A small unified-diff reader. Two consumers, and both of them are checks:
 *
 *   - the evidence bar needs the file set the diff ACTUALLY touches, so a proposal cannot
 *     under-declare `filesChanged` and slip an unimplicated file past the scope rule;
 *   - the prover needs each hunk on its own, because the mutant is defined mechanically as
 *     a revert of the fix and a multi-hunk patch whose hunks are individually inert is the
 *     poorly-scoped diff the research names as automated repair's central failure mode.
 *
 * Deliberately not a general patch library: it reads what `git diff` / `diff -u` emit and
 * throws on anything it does not understand rather than guessing.
 */

/** @typedef {{ index: number, header: string, lines: string[] }} Hunk */
/** @typedef {{ path: string, oldPath: string, headerLines: string[], hunks: Hunk[] }} FileDiff */

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function stripPrefix(p) {
  if (p === "/dev/null") return p;
  const m = /^[abciow]\/(.*)$/.exec(p);
  return m ? m[1] : p;
}

/**
 * @param {string} diffText
 * @returns {FileDiff[]}
 */
export function parseUnifiedDiff(diffText) {
  const text = String(diffText ?? "");
  if (text.trim() === "") return [];
  const lines = text.split("\n");
  /** @type {FileDiff[]} */
  const files = [];
  let cur = null;
  let hunk = null;
  let hunkIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      const oldPath = stripPrefix(line.slice(4).split("\t")[0].trim());
      const newPath = stripPrefix(lines[i + 1].slice(4).split("\t")[0].trim());
      cur = {
        path: newPath === "/dev/null" ? oldPath : newPath,
        oldPath,
        headerLines: [line, lines[i + 1]],
        hunks: [],
      };
      files.push(cur);
      hunk = null;
      i += 1;
      continue;
    }
    if (HUNK.test(line)) {
      if (cur === null) throw new Error(`unified diff: a hunk appeared before any file header: ${line}`);
      hunkIndex += 1;
      hunk = { index: hunkIndex, header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk !== null) {
      // Body lines are ' ', '-', '+', '\' (no newline marker) or the empty string that a
      // trailing split produces. Anything else ends the hunk.
      if (line === "" || line[0] === " " || line[0] === "-" || line[0] === "+" || line[0] === "\\") {
        hunk.lines.push(line);
        continue;
      }
      hunk = null;
    }
  }

  for (const f of files) {
    if (f.hunks.length === 0) throw new Error(`unified diff: file ${f.path} has no hunks`);
  }
  return files;
}

/** The set of paths the diff really touches, sorted. Under-declaring is what this catches. */
export function filesInDiff(diffText) {
  return [...new Set(parseUnifiedDiff(diffText).map((f) => f.path))].sort();
}

/** Total hunk count across all files. */
export function countHunks(diffText) {
  return parseUnifiedDiff(diffText).reduce((n, f) => n + f.hunks.length, 0);
}

/**
 * One applicable diff per hunk, tagged with its global index, so each hunk can be reverted
 * on its own. Trailing newline is always present: `git apply` refuses a truncated patch.
 * @returns {{ index: number, path: string, text: string }[]}
 */
export function splitHunks(diffText) {
  const out = [];
  for (const f of parseUnifiedDiff(diffText)) {
    for (const h of f.hunks) {
      const body = h.lines.filter((l, i) => !(l === "" && i === h.lines.length - 1));
      const text = [...f.headerLines, h.header, ...body].join("\n") + "\n";
      out.push({ index: h.index, path: f.path, text });
    }
  }
  return out;
}

/**
 * A diff hash that ignores the parts that legitimately move — the timestamps in the file
 * headers and git's `index` line — so "this exact repair was already ruled out" survives a
 * regenerated patch. Content only.
 */
export function normaliseDiff(diffText) {
  return String(diffText ?? "")
    .split("\n")
    .filter((l) => !l.startsWith("index ") && !l.startsWith("diff --git "))
    .map((l) => (l.startsWith("--- ") || l.startsWith("+++ ") ? l.split("\t")[0].trimEnd() : l.trimEnd()))
    .filter((l) => l !== "")
    .join("\n");
}
