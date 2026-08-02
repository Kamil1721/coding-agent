/**
 * project-runner.ts — a published project, actually running, on an address the
 * owner can click.
 *
 * WHAT WAS MISSING. `project-publish.ts` copies the finished code to
 * `projects/<slug>/` and `project-handover.ts` gives that copy a repository, a
 * README and a schema dump. All three leave INERT FILES. The owner's question
 * after opening one was "how do I see it?" — and the honest answer was a
 * terminal, a `cd`, and an `npm start` he has to know to type. This module
 * supervises that child process from the dashboard instead: one owner click, a
 * measured URL, bounded logs, and nothing left behind when the dashboard exits.
 *
 * NOTHING HERE EVER STARTS ANYTHING BY ITSELF. Not on boot, not on publish, not
 * on a list. `reconcileOnBoot` exists to KILL survivors of a dead dashboard and
 * has no path that spawns. A program that spends the machine's ports and CPU on
 * code an agent wrote, without the owner asking, is a different program.
 *
 * THE FOUR THINGS THAT MAKE THIS SAFE, each with the failure it prevents:
 *
 *   1. THE SLUG IS RESOLVED, NOT TRUSTED. This route spawns a process from a
 *      path a URL names. {@link resolveProjectDir} takes one path segment off an
 *      allowlist, joins it under `projects/`, and then RE-CHECKS CONTAINMENT ON
 *      THE REALPATH — so a symlink inside `projects/` pointing at
 *      `~/.ssh` is refused after resolution rather than before. `%2f` cannot
 *      reach it: `URL.pathname` does not decode, the allowlist has no `%`, and
 *      nothing below decodes a second time (the same construction
 *      `run-attachments.ts` uses).
 *
 *   2. THE CHILD DOES NOT INHERIT THIS PROCESS'S ENVIRONMENT.
 *      {@link CHILD_ENV_ALLOWLIST} is what crosses, plus `PORT` and `HOST`. The
 *      dashboard's own environment holds the owner's provider credentials and
 *      every `DASHBOARD_*` path; the code being started was written by an agent
 *      and is not reviewed. `{...process.env}` in the spawn call would hand a
 *      generated `server.mjs` the keys, and nothing downstream would notice.
 *
 *   3. THE CHILD IS ITS OWN PROCESS GROUP (`detached: true`), AND THAT IS WHAT
 *      MAKES THE KILL COMPLETE. `npm start` is a shell that spawns node: killing
 *      the npm pid alone leaves the server holding the port. `kill(-pgid)` takes
 *      the whole tree. The cost of `detached` is that the child NO LONGER dies
 *      with the dashboard's terminal — so the explicit kill in
 *      {@link ProjectRunner.stopAll} and {@link ProjectRunner.reconcileOnBoot}
 *      is the ONLY mechanism that stops one, not a backstop.
 *
 *   4. A NEGATIVE PID IS NEVER SIGNALLED WITHOUT {@link safeToSignalGroup}.
 *      `kill(-0, …)` signals THIS process's own group — the dashboard and the
 *      shell that launched it. The pgid on the boot path comes off a JSON file
 *      that can be stale, truncated or hand-edited, so `0`, `1`, this pid and
 *      this process's own group are refused by name and reported rather than
 *      sent a signal.
 *
 * READINESS IS MEASURED. `start` does not return a URL because `spawn` resolved;
 * it polls the port with a real HTTP request and returns only when something
 * ANSWERS (any status — a 404 and a 500 are both a server). A bare TCP connect
 * was rejected: it succeeds against a socket in a half-open state and against
 * whatever else grabbed the port in the allocation race window, which is the
 * "started but not serving" defect this repo exists to avoid. A child that never
 * answers is killed and the refusal carries its stderr.
 *
 * ONE PORT PER CHILD, MEASURED FREE AT ALLOCATION TIME. The range is
 * {@link PROJECT_PORT_MIN}-{@link PROJECT_PORT_MAX} and freeness is a real bind
 * on 127.0.0.1, not an assumption: this machine runs OrbStack containers that
 * publish ports and that set changes without warning. THE RESIDUAL RACE IS
 * STATED RATHER THAN HIDDEN — between our probe closing its socket and the child
 * binding, a few milliseconds pass in which something else can take the port.
 * That is why readiness is an HTTP probe and not bookkeeping, and why a child
 * that fails to bind surfaces as `start_timeout` with its own stderr attached.
 */

import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { redactForPersistence } from "bakeoff/dist/redact.js";
import type {
  ApiProject,
  ApiProjectExit,
  ApiProjectLogLine,
  ApiProjectLogs,
  ApiProjectProcess,
  ApiProjectsResponse,
} from "./api-types.js";
import type { DashboardPaths } from "./paths.js";
import { PROJECT_PUBLISH_RECORD } from "./project-publish.js";

/* -------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------- */

/**
 * The loopback window children are allocated from, inclusive.
 *
 * A DEDICATED RANGE so that a stray listener on 4400-4499 is recognisably a
 * project and not something the owner needs to hunt for. It is deliberately
 * clear of the dashboard API (4176), the UI (4319) and the run preview
 * (`preview.ts`, 4321-4340). Nothing in it is assumed free — see
 * {@link freeLoopbackPort}.
 */
export const PROJECT_PORT_MIN = 4400;
export const PROJECT_PORT_MAX = 4499;

/**
 * How long a project gets to answer before its start is a failure.
 *
 * 30 s covers `npm start` on a cold Next.js build; the one project on this
 * machine (`node server.mjs`) answers in well under a second. The child is
 * KILLED when this expires, so the cost of the generous bound is a wait, never
 * a leaked process.
 */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/** Between the HTTP probes that decide readiness. */
export const READY_POLL_MS = 100;

/**
 * SIGTERM, then this long, then SIGKILL.
 *
 * IT IS BUDGETED AGAINST `index.ts`'s HARD EXIT. That file arms
 * `setTimeout(() => process.exit(0), 3_000)` once shutdown starts, so every
 * child must be gone inside three seconds or the process exits over the top of
 * it and leaves exactly the orphan this module exists to prevent. 1 s grace +
 * a 250 ms confirmation after SIGKILL keeps a serial worst case under 1.5 s,
 * and `stopAll` kills every child in parallel rather than in sequence.
 */
export const STOP_GRACE_MS = 1_000;
export const STOP_KILL_CONFIRM_MS = 250;

/**
 * How long a failed `spawn` gets to say WHY, before the refusal goes without it.
 *
 * Node reports ENOENT and EACCES from `spawn` on the next tick, as an `error`
 * event — measured on node v25.9.0: `spawn npm ENOENT` arrives via
 * `process.nextTick`. 250 ms is three orders of magnitude more than that, so it
 * holds under load, and it is only ever waited on a path that has ALREADY
 * failed: no successful start pays it.
 */
export const SPAWN_ERROR_WAIT_MS = 250;

/**
 * What to do about a spawn that never produced a process.
 *
 * IT NAMES THE ENVIRONMENT DELIBERATELY. The child does not inherit this
 * process's — see {@link CHILD_ENV_ALLOWLIST} — so "npm works in my shell" and
 * "npm is on the PATH the dashboard hands the child" are different facts, and
 * the second is the one that failed.
 */
const SPAWN_REMEDIATION =
  "Is npm on the PATH this dashboard passes to children? The child gets an allowlisted environment, not this " +
  "process's, so a PATH exported by your shell profile is not necessarily on it. `PATH=… npm start` in the project " +
  "folder shows the same failure.";

/** Lines retained per project. A window, not a transcript — see {@link LogRing}. */
export const MAX_LOG_LINES = 200;

/** Per line, after redaction. A server that prints a 4 MB blob must not be held. */
export const MAX_LOG_LINE_CHARS = 2_000;

/** Under `paths.data`, beside the SQLite database. NOT inside `projects/`. */
export const RUNNER_STATE_FILE = "project-runner.json";

/**
 * EVERYTHING THE CHILD GETS FROM THIS PROCESS'S ENVIRONMENT, and no more.
 *
 * An allowlist rather than a denylist, because the thing being protected is
 * unbounded: the dashboard runs with whatever the owner's shell exports, which
 * includes provider credentials, and a denylist protects only the names
 * somebody remembered. `npm` needs `PATH` and `HOME` (its cache); the rest are
 * locale and temp-directory conveniences that no server should have to live
 * without.
 *
 * `NODE_ENV` IS DELIBERATELY ABSENT. Setting it to `production` would skip a
 * dev server's own dependencies; setting it to `development` would be a claim
 * about somebody else's project. It is left to the project's own scripts.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
  "TERM",
]);

/** The loopback literal, repeated nowhere else in this file. */
const LOOPBACK = "127.0.0.1";

/**
 * Longest slug this module will look at, and the character class it allows.
 *
 * `[A-Za-z0-9._-]` covers every folder `projectSlug` can produce (`[a-z0-9-]`)
 * plus the shapes an owner may have renamed one to. `.` is in the class, so
 * `.` and `..` are refused by name below rather than by the regex.
 */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_SLUG_CHARS = 128;

/* -------------------------------------------------------------------------
 * Refusals
 * ---------------------------------------------------------------------- */

/**
 * Why the runner would not do something, WITH the HTTP status.
 *
 * The status lives here and not in `http.ts` for `code-files.ts`'s reason: the
 * module that knows why it refused is the module that knows how bad it is, and
 * a router that re-derives the status is a second opinion that drifts.
 */
export type ProjectRefusalCode =
  | "invalid_project"
  | "unknown_project"
  | "no_start_script"
  | "no_free_port"
  | "start_failed"
  | "start_exited"
  | "start_timeout"
  | "bound_elsewhere"
  | "not_running";

export interface ProjectRefusal {
  readonly ok: false;
  readonly status: number;
  readonly code: ProjectRefusalCode;
  readonly message: string;
  readonly remediation: string | null;
}

export type ProjectStartOutcome = ProjectRefusal | { readonly ok: true; readonly started: boolean; readonly project: ApiProject };
export type ProjectStopOutcome = ProjectRefusal | { readonly ok: true; readonly stopped: true; readonly project: ApiProject };
export type ProjectLogsOutcome = ProjectRefusal | { readonly ok: true; readonly logs: ApiProjectLogs };

function refuse(
  status: number,
  code: ProjectRefusalCode,
  message: string,
  remediation: string | null,
): ProjectRefusal {
  return { ok: false, status, code, message, remediation };
}

/* -------------------------------------------------------------------------
 * Path resolution — the security boundary
 * ---------------------------------------------------------------------- */

/**
 * A slug that resolved.
 *
 * `identity` — NOT `directory` — is what the runner keys a child by; see
 * {@link ProjectRunner}. `directory` is the real path, and it is what gets
 * reported and spawned in.
 */
export interface ResolvedProject {
  readonly ok: true;
  readonly slug: string;
  readonly directory: string;
  /**
   * `dev:ino` — the FILESYSTEM'S OWN NAME for this directory, and the only
   * one-per-directory key available here.
   *
   * MEASURED, NOT ASSUMED. With `projects/shop` on disk, macOS
   * `realpathSync('…/projects/SHOP')` returns `…/projects/SHOP`: it resolves
   * symlinks but does NOT case-fold, and {@link SLUG_PATTERN} allows `A-Z`. Two
   * spellings, two strings, ONE DIRECTORY — and `statSync` on both returns the
   * same pair (measured on this machine: dev 16777232, ino 29127210 for each).
   * Keyed by the resolved path string, `start("shop")` and `start("SHOP")`
   * produced two `npm start` processes in one folder (pid 24124 on 4460, pid
   * 24153 on 4461), which is the corruption {@link ProjectRunner} keys by
   * directory to prevent.
   *
   * ON A CASE-SENSITIVE FILESYSTEM the two spellings really are two directories
   * and get two inodes, so they are correctly treated as two projects. Hard
   * links to directories do not exist, so an inode names one directory.
   */
  readonly identity: string;
}

export type ProjectDirResolution = ResolvedProject | ProjectRefusal;

/**
 * Turn one URL segment into a directory inside `projectsDir`, or refuse.
 *
 * THE REALPATH CHECK IS THE ONE THAT MATTERS. The spelled path is checked first
 * (cheap, and it catches `..` before any I/O), but a name that passes the
 * allowlist can still be a SYMLINK to somewhere else entirely — and it is the
 * resolved target that a spawned process would run from. Both the root and the
 * candidate are resolved, because on macOS `/var` is itself a symlink to
 * `/private/var` and a comparison against an unresolved root refuses every
 * legitimate project under a temp directory.
 *
 * A ROOT THAT DOES NOT EXIST IS `unknown_project`, NOT AN ERROR. `ensureDirs`
 * deliberately does not create `projects/` (see paths.ts), so a dashboard that
 * has never published anything has no such directory, and that is a fact about
 * the request rather than a fault.
 */
export function resolveProjectDir(projectsDir: string, slug: string): ProjectDirResolution {
  if (slug.length === 0 || slug.length > MAX_SLUG_CHARS || !SLUG_PATTERN.test(slug) || slug === "." || slug === "..") {
    return refuse(
      400,
      "invalid_project",
      `${JSON.stringify(slug)} is not a project name`,
      "Use the `slug` from GET /api/projects. It is one folder name — no slashes, no `..`, no absolute path.",
    );
  }
  let root: string;
  try {
    root = realpathSync(projectsDir);
  } catch {
    return refuse(404, "unknown_project", `there are no published projects yet (${projectsDir} does not exist)`, null);
  }
  const candidate = join(root, slug);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return refuse(404, "unknown_project", `no published project named ${slug}`, "GET /api/projects lists them.");
  }
  // RE-CHECKED ON THE RESOLVED PATH. `candidate` is inside `root` by
  // construction; `real` is only inside it if no link along the way pointed out.
  const rel = relative(root, real);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) {
    return refuse(
      400,
      "invalid_project",
      `${slug} resolves to ${real}, which is outside ${root}`,
      "A project must be a real directory directly inside projects/. A link that leaves it is refused: this route " +
        "starts a process from the path it resolves.",
    );
  }
  // ONE `stat`, TWO ANSWERS: is it a directory, and which directory is it. The
  // second is {@link ResolvedProject.identity} and cannot be recovered from the
  // path, which is the whole point.
  let info: Stats;
  try {
    info = statSync(real);
  } catch {
    return refuse(404, "unknown_project", `no published project named ${slug}`, "GET /api/projects lists them.");
  }
  if (!info.isDirectory()) {
    return refuse(404, "unknown_project", `${slug} is not a directory`, null);
  }
  return { ok: true, slug, directory: real, identity: `${String(info.dev)}:${String(info.ino)}` };
}

/**
 * The command that starts this project, or null when nothing here can be.
 *
 * ONLY `package.json`'s `start` SCRIPT. A static folder with an `index.html`
 * and no package.json is NOT started by inventing a server for it — the
 * dashboard already serves that shape at `GET /api/runs/:id/preview/*`, and
 * choosing a static server on the owner's behalf would be a claim about what
 * his project is.
 */
export function startCommandFor(directory: string): string | null {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const scripts = (parsed as Record<string, unknown>)["scripts"];
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return null;
    const start = (scripts as Record<string, unknown>)["start"];
    return typeof start === "string" && start.trim().length > 0 ? "npm start" : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * Ports
 * ---------------------------------------------------------------------- */

/**
 * The first port in the range that a real bind on 127.0.0.1 accepts.
 *
 * `exclusive: true` and an explicit host, both load-bearing. Without the host,
 * Node binds `::`/`0.0.0.0` and answers a question about a different address
 * from the one the child will use. Without `exclusive`, a cluster-aware bind can
 * succeed on a port another process holds.
 *
 * `taken` is this runner's own live children: they hold their ports through a
 * socket we cannot see from here (it belongs to the child), so a probe would
 * report them free the instant the child is between binds.
 */
export async function freeLoopbackPort(
  min: number,
  max: number,
  taken: ReadonlySet<number>,
): Promise<number | null> {
  for (let port = min; port <= max; port += 1) {
    if (taken.has(port)) continue;
    if (await portAcceptsBind(port)) return port;
  }
  return null;
}

function portAcceptsBind(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen({ host: LOOPBACK, port, exclusive: true }, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Does something ANSWER an HTTP request on this port?
 *
 * ANY STATUS COUNTS. A 404 from a server with no route at `/` and a 500 from one
 * that threw are both proof that a listener parsed a request and replied, which
 * is the claim `state: "running"` makes. Requiring 200 would refuse to report a
 * working API whose root is not a page.
 */
export function probeHttp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(answered);
    };
    const req = httpRequest(
      { host: LOOPBACK, port, path: "/", method: "GET", agent: false, timeout: timeoutMs },
      (res) => {
        res.resume();
        req.destroy();
        done(true);
      },
    );
    req.once("error", () => {
      done(false);
    });
    req.once("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
}

/**
 * Ports the child's process GROUP is listening on, for the honest refusal.
 *
 * ONLY EVER USED TO ENRICH A FAILURE. A project that ignores `PORT` and binds
 * its own is a real case — the requirement is to say so rather than hand back a
 * URL that answers nothing — but making a SUCCESS depend on `lsof` being
 * installed and on this parse being right would be a success-only observation on
 * a machine-dependent tool. So the child is still killed and the start still
 * refuses; this only lets the refusal name the port it actually took.
 *
 * `-a` ANDs the group filter with the socket filter. Without it lsof ORs them
 * and returns every listening socket on the machine, which would name a port
 * belonging to something else entirely.
 */
export function listeningPortsForGroup(pgid: number): readonly number[] {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  try {
    const out = execFileSync("lsof", ["-nP", "-a", "-g", String(pgid), "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ports = new Set<number>();
    for (const line of out.split("\n")) {
      const match = /:(\d+)\s+\(LISTEN\)/.exec(line);
      if (match?.[1] === undefined) continue;
      const port = Number.parseInt(match[1], 10);
      if (Number.isInteger(port)) ports.add(port);
    }
    return [...ports];
  } catch {
    // lsof exits non-zero when nothing matches, and may not be installed at
    // all. Either way the refusal below is a plain timeout, which is true.
    return [];
  }
}

/* -------------------------------------------------------------------------
 * Signals
 * ---------------------------------------------------------------------- */

/**
 * May we send a signal to `-pgid`?
 *
 * THE SINGLE MOST DANGEROUS LINE IN THIS MODULE IS `process.kill(-pgid, …)`,
 * and this is the guard in front of it. `kill(-0, sig)` signals the CALLER'S
 * OWN process group: the dashboard, and in a terminal the owner's shell and
 * everything else in that job. On the boot path the number comes off a JSON
 * file that may be stale, truncated or hand-edited, so `0` and `1` are refused
 * by value, and this process's own pid and group are refused by identity.
 */
export function safeToSignalGroup(pgid: number, self: { pid: number; pgid: number }): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (pgid === self.pid || pgid === self.pgid) return false;
  return true;
}

/**
 * This process's own pid and process group, cached.
 *
 * NODE HAS NO `getpgrp` BINDING — checked, it is not on `process` — so the group
 * comes from `ps`, once. The fallback when `ps` cannot answer is `process.pid`,
 * which is the RIGHT direction to be wrong in: a shell with job control puts the
 * dashboard in a group of its own whose pgid IS its pid, so the fallback still
 * refuses the most likely self-signal, and any other guess would have to be a
 * number that might belong to something real.
 */
let cachedOwnGroup: { pid: number; pgid: number } | null = null;

function ownGroup(): { pid: number; pgid: number } {
  if (cachedOwnGroup !== null) return cachedOwnGroup;
  let pgid = process.pid;
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = Number.parseInt(out.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) pgid = parsed;
  } catch {
    // Keep the pid. See above.
  }
  cachedOwnGroup = { pid: process.pid, pgid };
  return cachedOwnGroup;
}

/**
 * `ps`'s view of a process, as an identity to compare later.
 *
 * WHY A SIGNATURE AND NOT A BARE PID. Between a dashboard dying and the next one
 * booting, the operating system is free to hand that pid to something else —
 * the owner's editor, a container runtime. Killing a recycled pid's whole
 * process group would be the worst thing in this file. `lstart` (start time, to
 * the second) plus the command line is an identity a recycled pid effectively
 * cannot forge.
 *
 * Null when `ps` cannot answer. A null signature is NEVER killed on boot; it is
 * reported instead, because an unkillable orphan the owner is told about is
 * better than a signal sent on a guess.
 */
export function processSignature(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const text = out.replace(/\s+/g, " ").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * Logs
 * ---------------------------------------------------------------------- */

/**
 * Bounded, redacted output. Lines in, lines out, nothing unbounded in between.
 *
 * REDACTED AT THE SOURCE AND PER WHOLE LINE, which is a DIFFERENT CHOICE from
 * `BuildLog`'s `ReassemblingRedactor` and the reason is measured: that class
 * holds back a 16 KiB tail before it emits anything (`OVERLAP_WINDOW_CHARS`), so
 * a server whose entire output is `listening on 4400` would show ZERO lines
 * until it exited — and the stderr attached to a start failure, which is the
 * whole point of keeping logs, would be empty exactly when it is needed.
 *
 * The property that class exists for is preserved by ASSEMBLING FIRST: a chunk
 * boundary never reaches the matcher, because a line is only redacted once its
 * newline has arrived. WHAT IS GIVEN UP, STATED PLAINLY: a secret split across a
 * newline is not matched, and a line longer than {@link MAX_LOG_LINE_CHARS} is
 * truncated AFTER redaction (so a truncation can cut a placeholder, never a
 * secret). A process that emits no newline at all is force-flushed at twice the
 * line cap rather than buffered forever.
 */
class LogRing {
  #lines: ApiProjectLogLine[] = [];
  #dropped = 0;
  #partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

  write(stream: "stdout" | "stderr", chunk: string): void {
    let buffer = this.#partial[stream] + chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      this.#push(stream, buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LOG_LINE_CHARS * 2) {
      this.#push(stream, buffer);
      buffer = "";
    }
    this.#partial[stream] = buffer;
  }

  /** Flush whatever has no newline yet. Called when the child exits. */
  flush(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = this.#partial[stream];
      this.#partial[stream] = "";
      if (rest.length > 0) this.#push(stream, rest);
    }
  }

  lines(): readonly ApiProjectLogLine[] {
    return this.#lines;
  }

  dropped(): number {
    return this.#dropped;
  }

  /** The last `count` stderr lines, for a refusal's detail. Already redacted. */
  stderrTail(count: number): string {
    const errs = this.#lines.filter((line) => line.stream === "stderr").slice(-count);
    return errs.map((line) => line.text).join("\n");
  }

  #push(stream: "stdout" | "stderr", raw: string): void {
    const text = raw.replace(/\r$/, "");
    if (text.length === 0) return;
    const safe = redactForPersistence(text);
    const capped = safe.length > MAX_LOG_LINE_CHARS ? `${safe.slice(0, MAX_LOG_LINE_CHARS)}…` : safe;
    this.#lines.push({ stream, at: new Date().toISOString(), text: capped });
    while (this.#lines.length > MAX_LOG_LINES) {
      this.#lines.shift();
      this.#dropped += 1;
    }
  }
}

/* -------------------------------------------------------------------------
 * The runner
 * ---------------------------------------------------------------------- */

interface LiveChild {
  readonly slug: string;
  readonly directory: string;
  readonly port: number;
  readonly pid: number;
  readonly pgid: number;
  readonly startedAt: string;
  readonly signature: string | null;
  readonly process: ChildProcess;
  readonly logs: LogRing;
  readyAt: string | null;
  exit: ApiProjectExit | null;
  /** Set the moment the owner asks, so the exit handler can tell why it died. */
  stopRequested: boolean;
}

/** Persisted so the NEXT dashboard can kill what this one leaves behind. */
interface PersistedChild {
  readonly slug: string;
  readonly directory: string;
  readonly port: number;
  readonly pid: number;
  readonly pgid: number;
  readonly startedAt: string;
  readonly signature: string | null;
}

export type ProjectReconcileOutcome = "killed" | "gone" | "unverifiable" | "refused-unsafe-group";

export interface ProjectReconcileEntry {
  readonly slug: string;
  readonly pid: number;
  readonly outcome: ProjectReconcileOutcome;
  readonly detail: string;
}

export interface ProjectReconcileReport {
  readonly entries: readonly ProjectReconcileEntry[];
}

export interface ProjectRunnerOptions {
  readonly paths: DashboardPaths;
  /** TESTS ONLY. A one-port window makes `no_free_port` reachable. */
  readonly portRange?: { readonly min: number; readonly max: number } | undefined;
  readonly startTimeoutMs?: number | undefined;
  /** The environment {@link CHILD_ENV_ALLOWLIST} is read FROM. Defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** TESTS ONLY. See {@link listeningPortsForGroup}; the default shells out to lsof. */
  readonly listeningPorts?: ((pgid: number) => readonly number[]) | undefined;
}

export class ProjectRunner {
  readonly #paths: DashboardPaths;
  readonly #range: { readonly min: number; readonly max: number };
  readonly #startTimeoutMs: number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #listeningPorts: (pgid: number) => readonly number[];
  /**
   * KEYED BY {@link ResolvedProject.identity} — `dev:ino` — AND NOT BY ANY
   * SPELLING OF THE PATH. The difference is a data-loss bug rather than a
   * tidiness one.
   *
   * WHAT THE KEY HAS TO SURVIVE, both measured on this machine:
   *
   *   1. A SYMLINK INSIDE `projects/` pointing at a sibling. It resolves
   *      cleanly — it never leaves the root, so {@link resolveProjectDir}
   *      rightly allows it — so under a SLUG key `start("shop")` and
   *      `start("alias")` would be two entries. `realpathSync` collapses this
   *      one.
   *   2. TWO SPELLINGS OF ONE NAME. `realpathSync` does NOT case-fold and the
   *      slug allowlist has `A-Z`, so `shop` and `SHOP` gave two DIFFERENT
   *      resolved paths for one directory: `start("shop")` → pid 24124 on 4460,
   *      `start("SHOP")` → pid 24153 on 4461, two `npm start` processes in the
   *      same folder. `list()` showed only `shop:running` because it enumerates
   *      real directory names, so the second child was invisible to
   *      GET /api/projects and unreachable by `stop("shop")`.
   *
   * WHY IT MATTERS THAT MUCH: these folders ship a SQLite file
   * (`project-handover.ts` dumps its schema), and two writers on one database
   * file is corruption. Keyed by dev:ino, the second call in both cases is the
   * ordinary already-running answer.
   */
  readonly #children = new Map<string, LiveChild>();
  /**
   * In-flight starts, keyed the same way and for the same reasons. Two clicks on
   * the same button arrive as two requests; without this the second one
   * allocates a second port and spawns a second server for the same folder while
   * the first is still probing. A key that told the two spellings apart would
   * reopen the hole here even with {@link #children} closed.
   */
  readonly #starting = new Map<string, Promise<ProjectStartOutcome>>();

  constructor(options: ProjectRunnerOptions) {
    this.#paths = options.paths;
    this.#range = options.portRange ?? { min: PROJECT_PORT_MIN, max: PROJECT_PORT_MAX };
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.#env = options.env ?? process.env;
    this.#listeningPorts = options.listeningPorts ?? listeningPortsForGroup;
  }

  get portRange(): { readonly min: number; readonly max: number } {
    return this.#range;
  }

  /**
   * Every folder under `projects/`, with what this dashboard knows about it.
   *
   * NO PROBE PER PROJECT. The state comes from this process's own bookkeeping,
   * so listing is cheap enough for the UI to poll; `running` therefore means
   * "answered at `readyAt` and the process is still alive", which
   * `ApiProjectProcess` states.
   *
   * THE `runId` SCAN IS O(RUNS) PER CALL — one small JSON read per run
   * directory. Measured shape on this machine: 3 runs. It is not cached
   * because a cache would be a second source of truth for a file the publish
   * step rewrites, and the read is the same one `toDetail` already does per
   * request.
   */
  list(): ApiProjectsResponse {
    const projects: ApiProject[] = [];
    const byPath = this.#publishedRunsByPath();
    for (const name of this.#projectNames()) {
      const resolved = resolveProjectDir(this.#paths.projects, name);
      if (!resolved.ok) continue;
      projects.push(this.#describe(resolved, byPath));
    }
    return { projects, portRange: this.#range };
  }

  /**
   * Start one project and return only when its port ANSWERS.
   *
   * Already running is not a refusal: the caller asked for a running project
   * and there is one, so the existing URL comes back with `started: false` and
   * no second process is spawned.
   */
  async start(slug: string): Promise<ProjectStartOutcome> {
    const resolved = resolveProjectDir(this.#paths.projects, slug);
    if (!resolved.ok) return resolved;
    const key = resolved.identity;
    const inFlight = this.#starting.get(key);
    if (inFlight !== undefined) return inFlight;
    const attempt = this.#start(resolved).finally(() => {
      this.#starting.delete(key);
    });
    this.#starting.set(key, attempt);
    return attempt;
  }

  async stop(slug: string): Promise<ProjectStopOutcome> {
    const resolved = resolveProjectDir(this.#paths.projects, slug);
    if (!resolved.ok) return resolved;
    const child = this.#live(resolved.identity);
    if (child === null) {
      return refuse(
        409,
        "not_running",
        `${resolved.slug} is not running`,
        "POST /api/projects/<slug>/start first. GET /api/projects reports what is running.",
      );
    }
    child.stopRequested = true;
    await this.#killChild(child);
    this.#persist();
    return { ok: true, stopped: true, project: this.#describe(resolved, this.#publishedRunsByPath()) };
  }

  /**
   * Recent output. A project that has never run answers with an EMPTY list
   * rather than a refusal — "nothing was recorded" is the truthful answer to
   * the question, and a 404 there would be about the process rather than about
   * the project the caller named.
   */
  logs(slug: string): ProjectLogsOutcome {
    const resolved = resolveProjectDir(this.#paths.projects, slug);
    if (!resolved.ok) return resolved;
    const child = this.#children.get(resolved.identity);
    return {
      ok: true,
      logs: {
        slug: resolved.slug,
        lines: child?.logs.lines() ?? [],
        dropped: child?.logs.dropped() ?? 0,
        maxLines: MAX_LOG_LINES,
      },
    };
  }

  /**
   * Kill every child, in PARALLEL, inside the shutdown budget.
   *
   * Parallel because `index.ts` exits hard 3 s after shutdown begins
   * ({@link STOP_GRACE_MS} documents the arithmetic); serial kills of four
   * stubborn children would exceed it and leave the last ones orphaned holding
   * ports.
   */
  async stopAll(): Promise<void> {
    const live = [...this.#children.values()].filter((child) => child.exit === null);
    for (const child of live) child.stopRequested = true;
    await Promise.allSettled(live.map((child) => this.#killChild(child)));
    this.#persist();
  }

  /**
   * KILL what a dead dashboard left behind. NEVER START ANYTHING.
   *
   * `orchestrator.reconcileOnBoot`'s shape: read durable state, act on what a
   * crash left inconsistent, report it. The state here is
   * {@link RUNNER_STATE_FILE} — the children this dashboard's predecessor had
   * alive when it stopped being able to write to it.
   *
   * IT IS SYNCHRONOUS AND THE SIGKILL ESCALATION IS NOT. SIGTERM goes now; an
   * UNREF'D timer checks a second later and escalates to SIGKILL for anything
   * that ignored it. Unref'd so it can never hold the process open, and a second
   * because boot is not a deadline — unlike shutdown, nothing is waiting.
   */
  reconcileOnBoot(): ProjectReconcileReport {
    const entries: ProjectReconcileEntry[] = [];
    const self = ownGroup();
    for (const record of this.#readState()) {
      if (!safeToSignalGroup(record.pgid, self)) {
        entries.push({
          slug: record.slug,
          pid: record.pid,
          outcome: "refused-unsafe-group",
          detail:
            `the recorded process group ${String(record.pgid)} is this process's own, or 0/1. Signalling it would ` +
            "have hit the dashboard itself, so nothing was sent.",
        });
        continue;
      }
      const now = processSignature(record.pid);
      if (now === null) {
        entries.push({ slug: record.slug, pid: record.pid, outcome: "gone", detail: "no such process; nothing to kill" });
        continue;
      }
      if (record.signature === null || record.signature !== now) {
        entries.push({
          slug: record.slug,
          pid: record.pid,
          outcome: "unverifiable",
          detail:
            `pid ${String(record.pid)} is alive but is not the process this dashboard started (the recorded start ` +
            "time and command line do not match), so it was left alone. If a project is still holding a port, stop " +
            "it by hand.",
        });
        continue;
      }
      signalGroup(record.pgid, "SIGTERM", self);
      entries.push({
        slug: record.slug,
        pid: record.pid,
        outcome: "killed",
        detail: `left over from a previous dashboard on port ${String(record.port)}; SIGTERM sent to its process group`,
      });
      setTimeout(() => {
        if (processSignature(record.pid) !== null) signalGroup(record.pgid, "SIGKILL", self);
      }, STOP_GRACE_MS).unref();
    }
    this.#writeState([]);
    return { entries };
  }

  /* ---- internals ------------------------------------------------------ */

  async #start(resolved: ResolvedProject): Promise<ProjectStartOutcome> {
    const byPath = this.#publishedRunsByPath();
    const existing = this.#live(resolved.identity);
    if (existing !== null) {
      return { ok: true, started: false, project: this.#describe(resolved, byPath) };
    }
    if (startCommandFor(resolved.directory) === null) {
      return refuse(
        409,
        "no_start_script",
        `${resolved.slug} has no "start" script in a package.json, so there is nothing to run`,
        'Add {"scripts":{"start":"…"}} to the project\'s package.json. A static site needs no server: open its ' +
          "index.html, or use the run's preview route.",
      );
    }
    const port = await freeLoopbackPort(this.#range.min, this.#range.max, this.#takenPorts());
    if (port === null) {
      return refuse(
        503,
        "no_free_port",
        `every port from ${String(this.#range.min)} to ${String(this.#range.max)} is in use, so this project has ` +
          "nowhere to listen",
        "Stop another project, or free a port in that range. The range is reported by GET /api/projects.",
      );
    }

    const startedAt = new Date().toISOString();
    const logs = new LogRing();
    let child: ChildProcess;
    try {
      child = spawn("npm", ["run", "start"], {
        cwd: resolved.directory,
        // SEE THE FILE HEADER, POINT 3. Without this the child shares the
        // dashboard's process group and the group kill below becomes a kill of
        // the dashboard.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(this.#env, port),
      });
    } catch (error) {
      return refuse(500, "start_failed", `could not start ${resolved.slug}: ${describe(error)}`, SPAWN_REMEDIATION);
    }

    // THE `error` LISTENER IS ATTACHED BEFORE ANYTHING BELOW CAN RETURN, and
    // that ordering is the fix rather than a detail.
    //
    // Node reports a spawn that failed — ENOENT because npm is not on this
    // process's PATH, EACCES because the binary is not executable —
    // ASYNCHRONOUSLY: `spawn` returns a ChildProcess with `pid === undefined`
    // and emits `error` on the next tick. An `error` event with no listener is
    // an uncaught exception, and there is no `uncaughtException` handler
    // anywhere in server/src. Measured on node v25.9.0 against the previous
    // ordering, where the `pid === undefined` refusal returned first: the call
    // answered `start_failed`, and the DASHBOARD THEN DIED with
    // `Error: spawn npm ENOENT`, exit 1 — so the refusal never reached the
    // owner, `shutdown()` never ran, in-flight builds were aborted instead of
    // left resumable, and every project child already running became a detached
    // orphan holding a port.
    const spawnFailed = new Promise<string>((resolve) => {
      child.on("error", (error) => {
        const reason = describe(error);
        logs.write("stderr", `${reason}\n`);
        resolve(reason);
      });
    });

    const pid = child.pid;
    if (pid === undefined) {
      // WAIT FOR THE REASON RATHER THAN GUESSING AT IT. The event is one tick
      // away and carries `spawn npm ENOENT`; returning before it arrives put the
      // diagnosis in a log ring nobody reads and a guess in the refusal. Bounded
      // because this must answer even if the event never comes, and only ever
      // waited on a path that has already failed.
      const reason = await settledWithin(spawnFailed, SPAWN_ERROR_WAIT_MS);
      return refuse(
        500,
        "start_failed",
        reason === null
          ? `npm did not start for ${resolved.slug}, and the spawn reported no reason within ${String(
              SPAWN_ERROR_WAIT_MS,
            )} ms`
          : `could not start ${resolved.slug}: ${reason}`,
        SPAWN_REMEDIATION,
      );
    }

    const live: LiveChild = {
      slug: resolved.slug,
      directory: resolved.directory,
      port,
      pid,
      // `detached` makes the child a group leader, so its pgid IS its pid.
      pgid: pid,
      startedAt,
      signature: processSignature(pid),
      process: child,
      logs,
      readyAt: null,
      exit: null,
      stopRequested: false,
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      logs.write("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      logs.write("stderr", chunk);
    });
    // NO SECOND `error` LISTENER HERE. The one attached above the `pid` check
    // already writes every `error` to `logs` — including the ones that arrive
    // long after a successful spawn, which is what `kill` failures emit — and
    // two listeners would record each of them twice.
    //
    // THE EXIT HANDLER IS WHAT KEEPS `running` HONEST. A child that crashes
    // after readiness would otherwise stay in the map, and the next start would
    // hand back a URL nothing answers.
    child.on("exit", (code, signal) => {
      logs.flush();
      live.exit = {
        at: new Date().toISOString(),
        code,
        signal: signal ?? null,
        requested: live.stopRequested,
      };
      this.#persist();
    });
    this.#children.set(resolved.identity, live);
    this.#persist();

    const ready = await this.#awaitReady(live);
    if (ready !== null) return ready;

    live.readyAt = new Date().toISOString();
    this.#persist();
    return { ok: true, started: true, project: this.#describe(resolved, byPath) };
  }

  /** Null when it came up. A refusal otherwise, and the child is dead by then. */
  async #awaitReady(live: LiveChild): Promise<ProjectRefusal | null> {
    const deadline = Date.now() + this.#startTimeoutMs;
    for (;;) {
      if (live.exit !== null) {
        const detail = live.logs.stderrTail(20);
        await this.#killChild(live);
        return refuse(
          502,
          "start_exited",
          `${live.slug} exited immediately (code ${String(live.exit.code)}${
            live.exit.signal === null ? "" : `, signal ${live.exit.signal}`
          }) without listening on port ${String(live.port)}` + (detail.length > 0 ? `:\n${detail}` : ""),
          "Run `npm start` in the project folder to see the whole failure. GET /api/projects/<slug>/logs has the rest.",
        );
      }
      if (await probeHttp(live.port, 1_000)) return null;
      if (Date.now() >= deadline) break;
      await delay(READY_POLL_MS);
    }
    // IT NEVER ANSWERED. Before refusing, ask whether it bound a port of its
    // own — a project that ignores `PORT` is serving something, and saying so is
    // more use than "timed out".
    const elsewhere = this.#listeningPorts(live.pgid).filter((port) => port !== live.port);
    const stderr = live.logs.stderrTail(20);
    await this.#killChild(live);
    if (elsewhere.length > 0) {
      return refuse(
        502,
        "bound_elsewhere",
        `${live.slug} ignored PORT=${String(live.port)} and listened on ${elsewhere
          .map((port) => String(port))
          .join(", ")} instead. It was stopped rather than reported at an address the dashboard does not control.`,
        "Make the project read `process.env.PORT` (the README the publish step writes lists the variables it reads). " +
          "A hardcoded port cannot be run twice and collides with whatever else is on it.",
      );
    }
    return refuse(
      504,
      "start_timeout",
      `${live.slug} did not answer on http://${LOOPBACK}:${String(live.port)} within ${String(
        this.#startTimeoutMs,
      )} ms, so it was stopped` + (stderr.length > 0 ? `:\n${stderr}` : ""),
      "Check that the project's start script listens on `process.env.PORT`, and see " +
        "GET /api/projects/<slug>/logs for its output.",
    );
  }

  /**
   * SIGTERM to the GROUP, then SIGKILL if it is still there. Returns when the
   * child is gone or the budget is spent.
   */
  async #killChild(live: LiveChild): Promise<void> {
    if (live.exit !== null) return;
    const self = ownGroup();
    signalGroup(live.pgid, "SIGTERM", self);
    if (await waitForExit(live, STOP_GRACE_MS)) return;
    signalGroup(live.pgid, "SIGKILL", self);
    await waitForExit(live, STOP_KILL_CONFIRM_MS);
  }

  #live(identity: string): LiveChild | null {
    const child = this.#children.get(identity);
    return child !== undefined && child.exit === null ? child : null;
  }

  #takenPorts(): ReadonlySet<number> {
    const ports = new Set<number>();
    for (const child of this.#children.values()) {
      if (child.exit === null) ports.add(child.port);
    }
    return ports;
  }

  #projectNames(): readonly string[] {
    try {
      return readdirSync(this.#paths.projects, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      // `ensureDirs` deliberately does not create `projects/`. No directory
      // means nothing has ever been published, which is an empty list.
      return [];
    }
  }

  /**
   * THE CHILD IS LOOKED UP BY IDENTITY; EVERYTHING ELSE REPORTS THE CALLER'S OWN
   * RESOLUTION. `slug` and `path` are what was asked for, so that `list()` —
   * which enumerates real directory names — never labels a folder with a
   * spelling the owner did not use, while `process` describes the one child that
   * directory actually has.
   */
  #describe(resolved: ResolvedProject, byPath: ReadonlyMap<string, string>): ApiProject {
    const child = this.#children.get(resolved.identity);
    return {
      slug: resolved.slug,
      path: resolved.directory,
      startCommand: startCommandFor(resolved.directory),
      hasRepository: existsSync(join(resolved.directory, ".git")),
      runId: byPath.get(resolved.directory) ?? null,
      process: processStateOf(child),
    };
  }

  /**
   * Which run published which folder, read from each run's own publish record.
   *
   * The record's `path` is the absolute host path the copy went to, so this is a
   * lookup by directory rather than by slug — a folder the owner renamed no
   * longer matches, and that is correct: the record names a path, and a renamed
   * folder is not that path.
   */
  #publishedRunsByPath(): ReadonlyMap<string, string> {
    const byPath = new Map<string, string>();
    let runDirs: readonly string[];
    try {
      runDirs = readdirSync(this.#paths.runs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return byPath;
    }
    for (const runDir of runDirs) {
      const file = join(this.#paths.runs, runDir, "results", PROJECT_PUBLISH_RECORD);
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        const path = record["path"];
        const runId = record["runId"];
        if (record["published"] !== true || typeof path !== "string" || typeof runId !== "string") continue;
        byPath.set(realpathOr(path), runId);
      } catch {
        // No record, unreadable, or corrupt — the project simply has no run.
      }
    }
    return byPath;
  }

  #stateFile(): string {
    return join(this.#paths.data, RUNNER_STATE_FILE);
  }

  #persist(): void {
    const live: PersistedChild[] = [];
    for (const child of this.#children.values()) {
      if (child.exit !== null) continue;
      live.push({
        slug: child.slug,
        directory: child.directory,
        port: child.port,
        pid: child.pid,
        pgid: child.pgid,
        startedAt: child.startedAt,
        signature: child.signature,
      });
    }
    this.#writeState(live);
  }

  #writeState(children: readonly PersistedChild[]): void {
    try {
      mkdirSync(this.#paths.data, { recursive: true });
      writeFileSync(
        this.#stateFile(),
        `${JSON.stringify({ writtenAt: new Date().toISOString(), children }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // A dashboard that cannot write this file still supervises its own
      // children correctly — what is lost is the NEXT boot's ability to kill
      // them if this process dies without stopping them. Failing the start over
      // it would be worse.
    }
  }

  #readState(): readonly PersistedChild[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#stateFile(), "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
      const children = (parsed as Record<string, unknown>)["children"];
      if (!Array.isArray(children)) return [];
      const out: PersistedChild[] = [];
      for (const entry of children as readonly unknown[]) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const slug = record["slug"];
        const pid = record["pid"];
        const pgid = record["pgid"];
        const port = record["port"];
        const signature = record["signature"];
        if (typeof slug !== "string" || typeof pid !== "number" || typeof pgid !== "number") continue;
        out.push({
          slug,
          directory: typeof record["directory"] === "string" ? record["directory"] : "",
          port: typeof port === "number" ? port : 0,
          pid,
          pgid,
          startedAt: typeof record["startedAt"] === "string" ? record["startedAt"] : "",
          signature: typeof signature === "string" ? signature : null,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}

/* -------------------------------------------------------------------------
 * Free functions
 * ---------------------------------------------------------------------- */

/**
 * The child's whole environment. See {@link CHILD_ENV_ALLOWLIST}.
 *
 * `HOST` is set as well as `PORT` because the one published project on this
 * machine reads both, and because a project that honours `HOST` must be told
 * loopback: this module allocates a loopback port and a child that bound
 * 0.0.0.0 instead would put agent-written code on the network.
 */
export function childEnv(source: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env["PORT"] = String(port);
  env["HOST"] = LOOPBACK;
  return env;
}

function processStateOf(child: LiveChild | undefined): ApiProjectProcess {
  if (child === undefined) return { state: "stopped", lastExit: null };
  if (child.exit === null) {
    return {
      state: "running",
      url: `http://${LOOPBACK}:${String(child.port)}`,
      port: child.port,
      pid: child.pid,
      startedAt: child.startedAt,
      readyAt: child.readyAt ?? child.startedAt,
    };
  }
  if (child.exit.requested) return { state: "stopped", lastExit: child.exit };
  return { state: "exited", port: child.port, startedAt: child.startedAt, exit: child.exit };
}

function signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL", self: { pid: number; pgid: number }): void {
  if (!safeToSignalGroup(pgid, self)) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: it is already gone, which is the outcome we wanted. EPERM: it is
    // not ours, and the signature check upstream is what is supposed to catch
    // that — either way, throwing here would abort a shutdown loop partway.
  }
}

function waitForExit(live: LiveChild, ms: number): Promise<boolean> {
  if (live.exit !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      live.process.removeListener("exit", onExit);
      resolve(live.exit !== null);
    }, ms);
    const onExit = (): void => {
      clearTimeout(timer);
      // The runner's own `exit` listener may not have run yet; resolving on the
      // next tick lets it record the exit before anyone reads it.
      setTimeout(() => {
        resolve(true);
      }, 0);
    };
    live.process.once("exit", onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `promise`'s value if it arrives within `ms`, otherwise null.
 *
 * THE TIMER IS UNREF'D so that waiting for a diagnosis can never be the reason
 * this process stays alive. Its one caller passes the spawn `error` event, which
 * may legitimately never settle — and which cannot REJECT, since it is resolved
 * from an event handler. A rejecting promise would go unhandled here; this is
 * not a general-purpose race.
 */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    timer.unref();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function describe(error: unknown): string {
  return redactForPersistence(error instanceof Error ? error.message : String(error));
}
