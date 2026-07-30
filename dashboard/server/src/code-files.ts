/**
 * code-files.ts — the read-only view of ONE run's workspace, and the five
 * refusals that are the entire reason this file is separate from `http.ts`.
 *
 * WHY IT EXISTS. `RunDetail.artifactPath` is an absolute host path. The owner
 * cannot open it: the browser has no filesystem, and the dashboard's own answer
 * to "what did this run actually write" was, until now, "look in a terminal".
 * This module turns that directory into two JSON shapes — a flat tree and one
 * file's text — so the run page can show the code beside the record.
 *
 * IT IS A FILE-SERVING ENDPOINT, WHICH IS THE MOST DANGEROUS KIND OF ROUTE THIS
 * PROGRAM HAS. Five things are refused, and each one is refused HERE rather than
 * at the route, so that the tree walk and the content read cannot disagree:
 *
 * 1. PATH SHAPE. A relative path is REJECTED, never repaired. `safeSegment` was
 *    the obvious reuse and is the wrong tool: it is
 *    `replace(/[^A-Za-z0-9._-]/g, "_")`, so it turns `../../etc/passwd` into the
 *    legal filename `.._.._etc_passwd` and `visible-acceptance/x.mjs` into
 *    `visible-acceptance_x.mjs`. Mangling a traversal into a 404 makes a
 *    traversal test pass FOR THE WRONG REASON — the check never fires, the name
 *    merely stops existing — and it corrupts every legitimate path containing a
 *    separator, which is all of them. So `pathRefusal` rejects: absolute paths,
 *    any `.` or `..` or empty segment, backslashes, NUL, and anything over
 *    `MAX_PATH_CHARS`. `safeSegment` is still what maps the RUN ID to a
 *    directory — that is `runPathsFor`'s job and it is unchanged.
 *
 * 2. CONTAINMENT, ON REALPATHS, BOTH SIDES. A symlink inside the workspace
 *    pointing anywhere else resolves out, so containment is decided after
 *    `realpathSync` — and after realpathSync of the WORKSPACE too, because
 *    `mkdtempSync(tmpdir())` hands out `/var/folders/…` while the realpath is
 *    `/private/var/folders/…` on macOS. Comparing one resolved path against one
 *    unresolved root refuses every legitimate file in this package's own tests.
 *    `assertOutsideBakeoff` runs as a second, independent assertion on the
 *    resolved target; it is NOT the containment check (it only says "not inside
 *    bakeoff/", which every path outside the workspace also satisfies).
 *
 * 3. THE HELD-OUT BOUNDARY. Served from `runs/<id>/workspace` and nothing else.
 *    `visible-acceptance/` lives inside that directory and stays readable — it
 *    is the deliberate SUBSET the builder was given. `dashboard/acceptance`,
 *    `results/scorer-out` and `results/scores` are three levels up and carry
 *    held-out test titles verbatim; `results/scores` was found leaking exactly
 *    that. There is no allowlist of sealed directories here, deliberately: an
 *    enumeration of what to hide is a list somebody forgets to extend. The
 *    workspace root is the only thing inside the fence.
 *
 * 4. SECRET-SHAPED NAMES, ON BOTH BRANCHES. `denyReason` is called by the tree
 *    walk AND by the content read. Filtering only the tree is cosmetic: the tree
 *    is a convenience, `?path=.env` is the attack, and a viewer that hides
 *    `.git/config` from the list while serving it on request has a security
 *    control made of politeness.
 *
 * 5. CONTENT. Every byte that leaves here goes through
 *    `redactForPersistence` — a build agent that committed a key into source
 *    must not get it rendered into a browser tab — and then through
 *    `assertRedacted`, which is the redactor judging its own output. If the
 *    self-check still matches a rule the text is WITHHELD rather than shown:
 *    that is what "anything the redactor would flag is not served" means when
 *    the thing doing the flagging is a content scanner and not a filename list.
 *
 * And it is BOUNDED. This run's builder transcript is 12,369,476 bytes; a
 * response that size hangs the tab that asked for it. Files are capped at
 * `MAX_FILE_BYTES` and the tree at `MAX_TREE_ENTRIES`, both with an explicit
 * `truncated` flag on the wire, because a silent prefix is a lie about what the
 * run produced.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import { assertRedacted, redactForPersistence } from "bakeoff/dist/redact.js";
import type { CodeExclusion, CodeFileResponse, CodeTreeEntry, CodeTreeResponse } from "./api-types.js";
import { assertOutsideBakeoff } from "./paths.js";

/**
 * The most bytes of ONE file that reach the wire. 256 KiB.
 *
 * Chosen against the run this was built for: its `build.log` is 12,369,476
 * bytes and its largest source file is 10,212. A cap under a megabyte therefore
 * costs nothing on real source and is the difference between a readable page and
 * a frozen one on a transcript.
 */
export const MAX_FILE_BYTES = 256 * 1024;

/** Entries in one tree response. The real workspace has ~25 without `.git`. */
export const MAX_TREE_ENTRIES = 1_500;

/** How deep the walk goes before it stops descending. */
export const MAX_TREE_DEPTH = 12;

/** A relative path longer than this is not a path, it is a payload. */
export const MAX_PATH_CHARS = 1_024;

/**
 * How many leading bytes decide text-versus-binary.
 *
 * A NUL anywhere in this window means binary. The workspace holds `.jpg` and
 * `.png`; running the entropy rule over JPEG bytes yields a page of
 * `[REDACTED:HIGH_ENTROPY_TOKEN]` and no information at all.
 */
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Directories that are not the run's source and are not walked.
 *
 * `.git` is excluded for two reasons and either alone would be enough: it is
 * 2.8 MB of packed objects on this run, and `.git/config` carries the remote's
 * credentials while loose objects are zlib streams the redactor cannot read
 * through. `node_modules` is volume only.
 *
 * NOTHING ELSE IS HIDDEN. `.claude/`, `.bakeoff/`, `.design-tmp/` and
 * `visible-acceptance/` are all listed and all readable: the owner asked to see
 * what the run produced, and a viewer that quietly omits directories is
 * unfalsifiable — you cannot tell an empty workspace from a filtered one.
 */
const UNWALKED_DIRS: readonly string[] = Object.freeze([".git", "node_modules"]);

/**
 * Secret-shaped names, refused on BOTH branches (see header note 4).
 *
 * Matched against EVERY segment of the path, not just the basename: `.ssh/config`
 * must be refused by the directory, and a file cannot be reached without
 * traversing its parents.
 *
 * These are credential STORES — names whose only purpose is holding a secret.
 * Source files are deliberately not pattern-matched on words like `token` or
 * `secret`: `token.ts` is code, this project has `tokens.ts`, and blocking real
 * source to look careful hides the thing the owner opened the panel to read.
 * The general net for a credential that appears inside a legitimate file is
 * `redactForPersistence`, which runs on every byte served.
 */
const SECRET_NAME_RULES: readonly RegExp[] = Object.freeze([
  /^\.env$/i,
  /^\.env\..*$/i,
  /^.+\.env$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /\.(?:pem|key|p12|pfx|p8|jks|keystore|asc|gpg|ppk|kdbx)$/i,
  /^\.(?:npmrc|netrc|pgpass|htpasswd|pypirc|dockercfg|git-credentials|aws|ssh|gnupg)$/i,
  /^_netrc$/i,
  /^(?:secret|secrets|credential|credentials|service-account|serviceaccount)(?:\.[A-Za-z0-9]+)?$/i,
]);

/** A refusal, ready for `sendError`. */
export interface CodeRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

export type Resolved = { readonly ok: true; readonly target: string } | { readonly ok: false; readonly refusal: CodeRefusal };

/**
 * Why this path segment may not be served, or `null` to allow it.
 *
 * ONE PREDICATE, TWO CALLERS. The tree walk uses it to skip; the content read
 * uses it to refuse. A second copy of this list is how `?path=.env` becomes
 * fetchable from a viewer whose sidebar never showed it.
 */
export function denyReason(relPath: string): string | null {
  for (const segment of relPath.split("/")) {
    if (segment.length === 0) continue;
    if (UNWALKED_DIRS.includes(segment)) {
      return segment === ".git"
        ? "the git directory is not source: its objects are compressed past the redactor and its config holds remote credentials"
        : "installed dependencies are not this run's code";
    }
    for (const rule of SECRET_NAME_RULES) {
      if (rule.test(segment)) {
        return `${segment} is a credential file by name and is never served`;
      }
    }
  }
  return null;
}

/**
 * Reject a client-supplied relative path on SHAPE alone, before it touches the
 * filesystem. `null` means the shape is acceptable — not that the file exists.
 *
 * The value handed in must be the one `URLSearchParams` produced, which is
 * already percent-decoded ONCE. Do not decode it again: a second pass turns
 * `%252e%252e%252f` into `../` and hands the caller the traversal this function
 * exists to refuse.
 */
export function pathRefusal(relPath: string): CodeRefusal | null {
  const remediation =
    "Ask for a path exactly as the tree listed it: relative to the run's workspace, " +
    "forward slashes, no leading slash and no `..`.";
  if (relPath.length === 0) {
    return { status: 400, code: "invalid_path", message: "the path is empty", remediation };
  }
  if (relPath.length > MAX_PATH_CHARS) {
    return {
      status: 400,
      code: "invalid_path",
      message: `the path is ${String(relPath.length)} characters; the cap is ${String(MAX_PATH_CHARS)}`,
      remediation,
    };
  }
  if (relPath.includes("\0")) {
    return { status: 400, code: "invalid_path", message: "the path contains a NUL byte", remediation };
  }
  if (relPath.includes("\\")) {
    return {
      status: 400,
      code: "invalid_path",
      message: "the path contains a backslash",
      remediation,
    };
  }
  if (isAbsolute(relPath)) {
    return {
      status: 403,
      code: "path_not_relative",
      message: "an absolute path is refused; this route serves the run's workspace only",
      remediation,
    };
  }
  for (const segment of relPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return {
        status: 403,
        code: "path_escapes_workspace",
        message: `the path segment ${JSON.stringify(segment)} is refused`,
        remediation,
      };
    }
  }
  return null;
}

/** `true` when `target` is `root` or lives under it. Both must be realpaths. */
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve one relative path inside the run's workspace, or refuse.
 *
 * The order is the security argument: shape, then deny list, then realpath, then
 * containment, then `assertOutsideBakeoff`, then "is it a regular file". A
 * missing path is a 404 rather than an escaped `ENOENT` — an unhandled throw
 * here becomes a 500, and a test that only asserts "not 200" passes on a crash
 * while proving nothing about the check it was written for.
 */
export function resolveWorkspacePath(workspace: string, relPath: string): Resolved {
  const shape = pathRefusal(relPath);
  if (shape !== null) return { ok: false, refusal: shape };

  const denied = denyReason(relPath);
  if (denied !== null) {
    return {
      ok: false,
      refusal: {
        status: 403,
        code: "path_forbidden",
        message: denied,
        remediation:
          "Nothing clears this: the refusal is on the name, not on permissions. A credential " +
          "committed into a source file is redacted instead; a credential file is not served at all.",
      },
    };
  }

  let root: string;
  try {
    root = realpathSync(workspace);
  } catch {
    return {
      ok: false,
      refusal: {
        status: 404,
        code: "no_workspace",
        message: "this run has no workspace directory on disk",
        remediation: "A run that never reached its build segment wrote no files. Check the run's phase.",
      },
    };
  }

  let target: string;
  try {
    target = realpathSync(resolve(root, relPath));
  } catch {
    return {
      ok: false,
      refusal: {
        status: 404,
        code: "not_found",
        message: `no such file in this run's workspace: ${relPath}`,
        remediation: "Re-read the tree; the workspace may have changed since it was listed.",
      },
    };
  }

  // AFTER realpath, so a symlink pointing out of the workspace is caught by
  // where it LANDS rather than by how it is spelled.
  if (!within(root, target) || target === root) {
    return {
      ok: false,
      refusal: {
        status: 403,
        code: "path_escapes_workspace",
        message: `${relPath} resolves outside this run's workspace`,
        remediation:
          "This route serves one run's workspace. The sealed acceptance suite, the scorer output and " +
          "the score records live outside it and carry held-out test titles; they are not reachable " +
          "from here by any spelling, symlink or encoding.",
      },
    };
  }

  // An independent second assertion, on the resolved path. It cannot substitute
  // for the containment check above — "not inside bakeoff/" is true of the whole
  // filesystem — but the dashboard's rule is that no route reads out of the
  // bake-off tree, and this is where a symlink into it would arrive.
  try {
    assertOutsideBakeoff(target, "workspace file");
  } catch (error) {
    return {
      ok: false,
      refusal: {
        status: 403,
        code: "path_in_bakeoff",
        message: error instanceof BakeoffError ? error.message : "the path resolves into the bake-off tree",
        remediation: "The bake-off tree is not served by the dashboard. Nothing in it is a dashboard artefact.",
      },
    };
  }

  return { ok: true, target };
}

/* -------------------------------------------------------------------------
 * The tree
 * ---------------------------------------------------------------------- */

interface Walked {
  readonly entries: CodeTreeEntry[];
  readonly exclusions: CodeExclusion[];
  truncated: boolean;
}

function walk(root: string, dir: string, prefix: string, depth: number, out: Walked): void {
  if (out.truncated) return;
  if (depth > MAX_TREE_DEPTH) {
    out.exclusions.push({ path: prefix, reason: `deeper than ${String(MAX_TREE_DEPTH)} levels` });
    return;
  }

  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    out.exclusions.push({ path: prefix, reason: "not readable by this process" });
    return;
  }

  // Directories first, then files, each alphabetical. A stable order is what
  // makes the sidebar the same shape on every poll.
  const sorted = [...dirents].sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  for (const dirent of sorted) {
    if (out.entries.length >= MAX_TREE_ENTRIES) {
      out.truncated = true;
      return;
    }
    const path = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
    const denied = denyReason(dirent.name);
    if (denied !== null) {
      out.exclusions.push({ path, reason: denied });
      continue;
    }
    // A symlink is listed as neither: what it points at may be outside the
    // workspace, and `resolveWorkspacePath` would refuse it anyway. Recording it
    // is the honest alternative to a row that 403s when clicked.
    if (dirent.isSymbolicLink()) {
      out.exclusions.push({ path, reason: "a symlink; only files inside this workspace are served" });
      continue;
    }
    if (dirent.isDirectory()) {
      out.entries.push({ path, name: dirent.name, type: "dir", bytes: null });
      walk(root, join(dir, dirent.name), path, depth + 1, out);
      continue;
    }
    if (!dirent.isFile()) {
      out.exclusions.push({ path, reason: "not a regular file" });
      continue;
    }
    let bytes = 0;
    try {
      bytes = statSync(join(dir, dirent.name)).size;
    } catch {
      out.exclusions.push({ path, reason: "not readable by this process" });
      continue;
    }
    out.entries.push({ path, name: dirent.name, type: "file", bytes });
  }
}

/**
 * The whole workspace in one response.
 *
 * FLAT, NOT NESTED, and returned in full rather than one directory per request.
 * The real workspace is ~25 entries once `.git` is out, so lazy loading would
 * buy a click-to-render waterfall and nothing else; nesting is the client's job
 * because the client is the thing that knows which folders are open.
 */
export function readWorkspaceTree(workspace: string, runId: string): CodeTreeResponse | CodeRefusal {
  let root: string;
  try {
    root = realpathSync(workspace);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      status: 404,
      code: "no_workspace",
      message: "this run has no workspace directory on disk",
      remediation:
        "A run that was cancelled before its build segment wrote no files. The run record still has " +
        "its ticket, trace and criteria.",
    };
  }
  const out: Walked = { entries: [], exclusions: [], truncated: false };
  walk(root, root, "", 1, out);
  return {
    kind: "tree",
    runId,
    root: workspace,
    entries: out.entries,
    exclusions: out.exclusions,
    truncated: out.truncated,
  };
}

/* -------------------------------------------------------------------------
 * One file
 * ---------------------------------------------------------------------- */

function countRedactions(text: string): number {
  return text.split("[REDACTED:").length - 1;
}

/**
 * One file's text, capped, redacted, and honest about both.
 *
 * TRUNCATE, THEN DECODE, THEN REDACT — in that order, so the redactor sees
 * EXACTLY the bytes that ship. Redacting the whole file and then slicing would
 * mean the cap could cut a placeholder in half and, worse, that the scan proving
 * the response safe ran over text the response does not contain.
 */
export function readWorkspaceFile(target: string, relPath: string, runId: string): CodeFileResponse | CodeRefusal {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return {
      status: 404,
      code: "not_found",
      message: `no such file in this run's workspace: ${relPath}`,
      remediation: "Re-read the tree.",
    };
  }
  if (stat.isDirectory()) {
    return {
      status: 400,
      code: "not_a_file",
      message: `${relPath} is a directory`,
      remediation: "Ask for a file. The tree marks directories with type `dir`.",
    };
  }
  if (!stat.isFile()) {
    return {
      status: 403,
      code: "not_a_file",
      message: `${relPath} is not a regular file`,
      remediation: "Only regular files are served: a socket or device node is not this run's code.",
    };
  }

  const truncated = stat.size > MAX_FILE_BYTES;
  let buffer: Buffer;
  try {
    buffer = readFileSync(target);
  } catch {
    return {
      status: 403,
      code: "not_readable",
      message: `${relPath} could not be read`,
      remediation: "Check the file's permissions on disk.",
    };
  }
  const head = buffer.subarray(0, Math.min(buffer.byteLength, BINARY_SNIFF_BYTES));
  if (head.includes(0)) {
    return {
      kind: "file",
      runId,
      path: relPath,
      bytes: stat.size,
      text: null,
      binary: true,
      truncated: false,
      redactions: 0,
      withheld: null,
    };
  }

  const raw = buffer.subarray(0, MAX_FILE_BYTES).toString("utf8");
  const text = redactForPersistence(raw);

  // THE REDACTOR JUDGING ITS OWN OUTPUT. If a credential pattern still matches
  // after the chokepoint has run, the honest response is to serve nothing and
  // say so — not to paint the key across a browser tab because a placeholder
  // failed to substitute.
  try {
    assertRedacted(text);
  } catch {
    return {
      kind: "file",
      runId,
      path: relPath,
      bytes: stat.size,
      text: null,
      binary: false,
      truncated,
      redactions: countRedactions(text),
      withheld:
        "The redaction self-check still matched a credential pattern after redaction, so this file " +
        "is not shown. Read it in a terminal if you need it.",
    };
  }

  return {
    kind: "file",
    runId,
    path: relPath,
    bytes: stat.size,
    text,
    binary: false,
    truncated,
    redactions: countRedactions(text),
    withheld: null,
  };
}

/** `true` when the value is a refusal rather than a response. */
export function isRefusal(value: CodeRefusal | { readonly kind: string }): value is CodeRefusal {
  return !("kind" in value);
}
