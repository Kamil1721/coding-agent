/**
 * secret-intake.ts — the local box the owner pastes a credential into, and the
 * only place its value is ever written.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE SAFE PATH RATHER THAN A CONVENIENCE. The
 * owner's standing rule is that a credential must never be pasted into a chat:
 * the transcript is written to disk and synced, so a pasted key is exposed and
 * has to be rotated. The correct alternative is a form on a loopback page whose
 * value goes straight to this process and onto disk — the value never passes
 * through a model, a prompt or a transcript. That is what this file is. It will
 * be trusted, so every claim below is either enforced here or reported as not
 * enforced; nothing is left implied.
 *
 * ─── WHERE THE VALUE LIVES, AND WHY NOT IN THE WORKSPACE ───
 *
 * Outside the run workspace, under `dashboard/data/secrets/.env`. The workspace
 * is the wrong home for four measured reasons, not one: it is `git diff`-ed for
 * the judge, it is copied to `results/staging` by the scorer, it is captured in
 * screenshots — `bakeoff/.gitignore` states that masking is applied at capture
 * time and is the only masking there is, so a value rendered by a selector
 * nobody anticipated is in the pixels permanently — and it is mounted into the
 * sealed scorer container. A file under `dashboard/data/` is in none of those
 * four places.
 *
 * ─── WHO GETS THE VALUE, AND WHO GETS ONLY THE NAME ───
 *
 * THE BUILD SUBPROCESS GETS THE NAME. NOT THE VALUE. This is a deliberate
 * departure from "inject it into the build subprocess env at spawn", and the
 * reason is primary-source rather than taste:
 *
 *   1. The build subprocess is an LLM agent with Bash. A value in its
 *      environment is one `env` away from its own transcript.
 *   2. That transcript is persisted through `redactForPersistence`, whose
 *      known-value pass reads `DEFAULT_KNOWN_ENV_NAMES` — four provider
 *      variables (`redact.ts:218-223`) — from `process.env` by default
 *      (`redact.ts:294-315`). Every dashboard call site passes NO options
 *      (`orchestrator.ts:1062`, `:1588`, `:1875`; `db.ts:573` and every other
 *      write). So an intake secret is covered by the SHAPE rules only: an
 *      `sk-…`, `sk_live_…`, `ghp_…`, JWT or 40+ char mixed-case-and-digit token
 *      is caught; a 24-char lowercase-hex API key is not. Measured in
 *      `secret-intake.test.ts` in both directions.
 *   3. `subscriptionSubprocessEnv` is also the environment of the SPEC and JUDGE
 *      seats (`orchestrator.ts:766`, `:777`), so injecting there would hand the
 *      value to seats that have no use for it at all.
 *
 * Hence {@link secretsForBuildPrompt}: the builder is told the NAMES that will
 * be present at run time, so it writes `process.env.STRIPE_SECRET_KEY` rather
 * than a literal, and {@link projectSecretEnv}, whose one legitimate consumer is
 * a NON-AGENT runtime process — the preview server that serves the artefact.
 * That injection site is `preview.ts`, which this phase does not own; the
 * feature is therefore UNWIRED on that side and says so rather than pretending.
 *
 * ─── WHAT THIS CANNOT DO, SAID PLAINLY ───
 *
 * A STATIC artefact needs nothing at run time and the frozen manifest declares
 * which one it is: `execution.start === null` is a static artefact the scorer
 * serves itself (`scorer-protocol.ts:440-451`). For that shape a secret is
 * needed at BUILD time at most, and usually not at all.
 *
 * A SERVER artefact does need it at run time, and there the honest answer has
 * two halves. The preview server this dashboard starts on the host CAN be given
 * the value (that is `projectSecretEnv`, unwired as above). THE SEALED GATE
 * CANNOT AND MUST NOT. `gateEnv` (`paths.ts:183-195`) is an allowlist of four
 * variables and the container runs `--network=none`. So a criterion that needs a
 * live third-party service — a real Stripe charge, a real email delivery —
 * cannot pass the gate with this feature or without it. Nothing here makes that
 * possible, and {@link GATE_LIMIT_NOTE} is rendered in the box so the feature
 * does not imply otherwise.
 *
 * ─── THE INTAKE IS NOT A HOLE IN THE METERED-CREDENTIAL SUBTRACTION ───
 *
 * `STRIPPED_ENV_NAMES` is imported as a VALUE and every name in it is REFUSED at
 * intake. Order is the reason: any injection happens after the subtraction, so
 * an intake-supplied `ANTHROPIC_API_KEY` would re-enter the environment the
 * subtraction had just cleaned, silently flip a run to metered per-token billing
 * and leave `costUsd: null` reporting a subscription run. That is the exact bug
 * `subprocess-env.ts` exists to prevent, and it must not be reachable through a
 * web form. Importing the list rather than copying it means a name added there
 * extends this refusal automatically.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";
import type { RedactOptions } from "bakeoff/dist/redact.js";
import {
  SUITE_MANIFEST_FILENAME,
  parseSuiteManifest,
  resolveExecutionPlan,
} from "bakeoff/dist/scorer-protocol.js";
import { suiteRootFor } from "bakeoff/dist/spec-freeze.js";
import type { DashboardPaths } from "./paths.js";
import { STRIPPED_ENV_NAMES } from "./subprocess-env.js";

/* -------------------------------------------------------------------------
 * The store's location
 * ---------------------------------------------------------------------- */

/** Under `dashboard/data`, which `.gitignore` already excludes as a directory. */
export const SECRET_STORE_DIRNAME = "secrets";

/**
 * `.env`, and the name is load-bearing rather than cosmetic.
 *
 * TWO INDEPENDENT `.gitignore` RULES HAVE TO MISS BEFORE THIS FILE IS
 * COMMITTABLE: the root `dashboard/data/` rule (which covers the directory) and
 * the root `.env` rule (which is unanchored and therefore matches at any depth).
 * Verified by running `git check-ignore -v` against a real file at this path —
 * checking a path that does not exist returns nothing and reads exactly like a
 * rule that does not work, which is a defect this repository has already hit.
 */
export const SECRET_STORE_FILENAME = ".env";

/** `dashboard/data/secrets/.env` for the default home. */
export function secretStoreFile(paths: DashboardPaths): string {
  return join(paths.data, SECRET_STORE_DIRNAME, SECRET_STORE_FILENAME);
}

/* -------------------------------------------------------------------------
 * What may be stored
 * ---------------------------------------------------------------------- */

/**
 * A POSIX environment variable name, upper-case only.
 *
 * Narrow on purpose: this string is interpolated into an env file and handed to
 * `spawn`, and the set of names that are legal in both is smaller than the set
 * of strings a form can post. Lower-case is refused so a name can never collide
 * with a shell function name, and the 64-character ceiling is well past any real
 * variable.
 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Eight characters, and this floor is inherited rather than invented.
 *
 * `redact.ts`'s `isUsableSecret` skips any known value shorter than 8 characters
 * (`redact.ts:280-286`), so a 7-character value registered with the redactor
 * would be silently un-redactable — the known-value pass would `continue` past
 * it and the box would have promised protection it does not have. Refusing it at
 * intake is the only way to keep the promise honest.
 */
export const MIN_SECRET_VALUE_CHARS = 8;

/**
 * 8 KiB. Comfortably past a PEM-armoured RSA-4096 private key, which is the
 * longest credential `CREDENTIAL_RULES` can match, and far below the 1 MiB HTTP
 * body cap so a refusal here is a clean 400 rather than a socket error.
 */
export const MAX_SECRET_VALUE_CHARS = 8192;

/** A refusal the HTTP layer can send verbatim. Never quotes the value. */
export interface SecretRefusal {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

/** Null when the name is acceptable. Never includes the value in its message. */
export function refuseSecretName(name: unknown): SecretRefusal | null {
  if (typeof name !== "string" || name.length === 0) {
    return {
      code: "invalid_secret_name",
      message: "name must be a non-empty string",
      remediation: "Post the environment variable NAME, e.g. STRIPE_SECRET_KEY.",
    };
  }
  if (!SECRET_NAME_RE.test(name)) {
    return {
      code: "invalid_secret_name",
      message: `name ${JSON.stringify(name)} is not an upper-case environment variable name`,
      remediation:
        "Use A-Z, 0-9 and underscore, starting with a letter, at most 64 characters. This string is " +
        "written into an env file and handed to spawn(); a name that is not legal in both is refused " +
        "rather than escaped.",
    };
  }
  if (STRIPPED_ENV_NAMES.includes(name)) {
    return {
      code: "refused_metered_credential",
      message: `${name} is removed from every subprocess environment on purpose and may not be re-supplied here`,
      remediation:
        "This dashboard drives CLIs that are already logged in to the owner's subscriptions, and " +
        "subprocess-env.ts deletes the metered credentials from every environment it spawns so a run " +
        "cannot be billed per token while the dashboard reports costUsd: null. Injection happens after " +
        "that subtraction, so accepting this name here would silently undo it. If a metered key is " +
        "genuinely wanted, that is a deliberate change to STRIPPED_ENV_NAMES, not a paste into a form.",
    };
  }
  return null;
}

/** Null when the value is acceptable. NEVER quotes or measures the value. */
export function refuseSecretValue(value: unknown): SecretRefusal | null {
  if (typeof value !== "string") {
    return {
      code: "invalid_secret_value",
      message: "value must be a string",
      remediation: "Post {\"name\":\"…\",\"value\":\"…\"} as JSON.",
    };
  }
  if (value.trim().length < MIN_SECRET_VALUE_CHARS) {
    return {
      code: "invalid_secret_value",
      message: `value must be at least ${String(MIN_SECRET_VALUE_CHARS)} characters after trimming`,
      remediation:
        "The redaction chokepoint skips known values shorter than 8 characters, so a shorter secret " +
        "could not be scrubbed from a transcript even after being registered. It is refused here " +
        "rather than accepted with a promise that does not hold.",
    };
  }
  if (value.length > MAX_SECRET_VALUE_CHARS) {
    return {
      code: "invalid_secret_value",
      message: `value is longer than the ${String(MAX_SECRET_VALUE_CHARS)}-character cap`,
      remediation: "A credential is not an upload. Check you pasted one value and not a whole file.",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------
 * The file format
 * ---------------------------------------------------------------------- */

/**
 * `NAME="json-quoted value"`.
 *
 * JSON-quoted rather than raw, because a PEM private key — named in
 * `redact.ts`'s first rule and a real thing an owner pastes — contains newlines,
 * and a raw `NAME=value` line would silently truncate at the first one and store
 * a broken credential that looks stored. JSON quoting round-trips newlines,
 * quotes and backslashes exactly, and the result is still the dotenv
 * double-quoted form.
 */
function encodeEntry(name: string, value: string): string {
  return `${name}=${JSON.stringify(value)}`;
}

const ENTRY_RE = /^([A-Z][A-Z0-9_]{0,63})=(.*)$/;

/**
 * Read the store. Values are RETURNED — this is the one function that hands a
 * caller a credential, and every caller of it is named in this file's header.
 *
 * A malformed line is SKIPPED rather than thrown on: this file is written only
 * by {@link putSecret}, but a half-written file (an editor, a crash) must not
 * take the dashboard's HTTP layer down on a route whose job is to report which
 * names exist.
 */
export function readSecretStore(file: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = ENTRY_RE.exec(trimmed);
    if (match === null) continue;
    const name = match[1] ?? "";
    const raw = match[2] ?? "";
    if (!raw.startsWith('"')) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value === "string") out.set(name, value);
    } catch {
      continue;
    }
  }
  return out;
}

/** The names on file, sorted. Presence, never value — safe to send anywhere. */
export function storedSecretNames(file: string): readonly string[] {
  return [...readSecretStore(file).keys()].sort();
}

/**
 * Write or replace one value, and leave the file 0600 and the directory 0700.
 *
 * TEMP FILE PLUS RENAME, AND THE MODE IS SET EXPLICITLY EVERY TIME. Two failure
 * modes are being avoided at once. `writeFileSync`'s `mode` option is ignored
 * when the file already exists, so ROTATION — the second write — is exactly
 * where a 0600 file silently becomes whatever mode was there before; and
 * `mkdirSync`'s mode is masked by the process umask, so a 0700 request can
 * arrive as 0755. Both are asserted in `secret-intake.test.ts` on the SECOND
 * write as well as the first.
 *
 * The rename is also what makes the write atomic: a reader never sees a
 * truncated store, and a crash mid-write leaves the previous file intact.
 */
export function putSecret(file: string, name: string, value: string): void {
  const nameRefusal = refuseSecretName(name);
  if (nameRefusal !== null) throw new Error(nameRefusal.message);
  const valueRefusal = refuseSecretValue(value);
  if (valueRefusal !== null) throw new Error(valueRefusal.message);

  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const entries = new Map(readSecretStore(file));
  entries.set(name, value);
  const body = `${[...entries.keys()]
    .sort()
    .map((key) => encodeEntry(key, entries.get(key) ?? ""))
    .join("\n")}\n`;

  const temp = `${file}.tmp`;
  writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

/** Mode bits of a path, or null when it does not exist. For tests and reports. */
export function fileMode(path: string): number | null {
  if (!existsSync(path)) return null;
  return statSync(path).mode & 0o777;
}

/* -------------------------------------------------------------------------
 * Redaction
 * ---------------------------------------------------------------------- */

/**
 * Options that make `redactForPersistence` scrub the stored values.
 *
 * BOTH FIELDS, AND THE `env` ONE IS THE WHOLE POINT. `redactKnownEnvValues`
 * looks each name up in an environment (`redact.ts:294-315`), defaulting to
 * `process.env`. These values live in a FILE and are deliberately absent from
 * the dashboard's own `process.env`, so `{ knownEnvNames: [name] }` alone
 * resolves `undefined`, hits the `continue`, and redacts NOTHING — while a test
 * that supplies both a name list and a hand-built env passes and looks like
 * proof. The test file executes that negative control and reports it.
 *
 * The returned object CONTAINS the credential values. It is an argument to the
 * redactor and nothing else: never log it, never persist it, never return it
 * from a route.
 */
export function secretRedactOptions(file: string): RedactOptions {
  const entries = readSecretStore(file);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of entries) env[name] = value;
  return { knownEnvNames: [...entries.keys()], env };
}

/**
 * Every stored value, for injection into a NON-AGENT runtime subprocess.
 *
 * Its one legitimate consumer is the preview server that serves a SERVER
 * artefact on the host. Not the builder (an agent with Bash), not a seat, and
 * never the sealed gate — see this file's header for each.
 */
export function projectSecretEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of readSecretStore(file)) out[name] = value;
  return out;
}

/**
 * The sentence a build prompt may carry: NAMES, and an instruction to read them
 * from the environment rather than to invent a literal.
 *
 * Returns "" for an empty store, so a caller cannot append an empty heading that
 * reads like a declaration of nothing.
 */
export function secretsForBuildPrompt(file: string): string {
  const names = storedSecretNames(file);
  if (names.length === 0) return "";
  return (
    "Credentials available at run time, BY NAME ONLY:\n" +
    names.map((name) => `- process.env.${name}`).join("\n") +
    "\nRead them from the environment. Never write a credential literal into a file, a test, a " +
    "fixture or a commit, and never print one to stdout: this run's transcript is persisted."
  );
}

/**
 * Does `text` contain any stored value verbatim?
 *
 * A LAST-LINE GUARD FOR RESPONSE BODIES, not a redactor: it answers a yes/no
 * question about a string this process is about to send, and the routes in
 * `http.ts` refuse to send a body it flags. Exact substring only — an encoded
 * form is `redactForPersistence`'s job and this is not a second implementation
 * of it.
 */
export function containsStoredSecret(text: string, file: string): boolean {
  for (const value of readSecretStore(file).values()) {
    if (value.length > 0 && text.includes(value)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Detection — how the box knows it is needed
 * ---------------------------------------------------------------------- */

/**
 * What the FROZEN MANIFEST declares about run time, which is the only part of
 * this question anybody currently declares.
 *
 * `execution.start === null` is a STATIC artefact the scorer serves itself;
 * a non-null `start` is a SERVER artefact (`scorer-protocol.ts:412-451`). The
 * manifest is authored by the SPEC SEAT (`bakeoff/src/spec-agent.ts:284`) before
 * any implementation exists, which is what makes this a declaration rather than
 * an inference about code somebody wrote later.
 *
 * `unknown` when there is no frozen suite yet — a run in its spec phase, or a
 * ticket authored before this file existed. Degrading rather than throwing
 * mirrors `orchestrator.ts:733-739`, which wraps the same read in try/catch for
 * the same reason.
 *
 * WHAT IT DOES NOT DECLARE: NAMES. `SuiteManifest` has no field for required
 * environment variables (`scorer-protocol.ts:491-504`), and `bakeoff/` is not
 * this package's to modify — `paths.ts:46` calls it read-only in so many words.
 * So the declared half answers "is anything needed at run time at all", and the
 * names come from the store or from the measured inference below.
 */
export type DeclaredRuntimeMode = "static" | "server" | "unknown";

export function declaredRuntimeMode(acceptanceRoot: string, ticketId: string): DeclaredRuntimeMode {
  try {
    const manifestPath = join(suiteRootFor(ticketId, acceptanceRoot), SUITE_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return "unknown";
    const manifest = parseSuiteManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    // `resolveExecutionPlan` OWNS the discriminator upstream (`start === null` is
    // static). Calling it rather than re-testing `start` here means a change to
    // what "static" means arrives with the protocol instead of drifting.
    return resolveExecutionPlan(manifest.execution).mode;
  } catch {
    return "unknown";
  }
}

/**
 * Names that LOOK like a credential rather than configuration.
 *
 * ─── THE FALSE-POSITIVE MEASUREMENT, RUN BEFORE THIS WAS ALLOWED TO SHOW
 * ANYTHING (2026-07-30, four corpora on this machine) ───
 *
 *   corpus                                    raw   raw stripped   filtered
 *   the real run's workspace (run-2026-07-29)    1        1             0
 *   dashboard/src (a real Next client)           2        2             0
 *   dashboard/server/src                         9        6             0
 *   bakeoff/src                                 16       14             0
 *   union                                       26        —             0
 *
 * Raw false-positive rate: 23 of the 26 distinct names are not credentials at
 * all — `PATH`, `HOME`, `PORT`, `CI`, `BAKEOFF_*`, `NEXT_PUBLIC_*` — which is 88%
 * and is why a name filter exists at all. But the name filter alone still let two
 * through, and **both of those were false positives too**: `API_KEY` from a doc
 * comment in `bakeoff/src/spec-validate.ts:513`, and `STRIPE_SECRET_KEY` from a
 * doc comment in this very file. Comment stripping (see {@link scanEnvReads})
 * takes the filtered union from 2 to ZERO across all four corpora — and zero is
 * the correct answer, because no artefact on this machine actually reads a
 * credential from its environment.
 *
 * SO THE MEASURED TRUE-POSITIVE COUNT IS ZERO, and the honest reading is that
 * this inference is unproven rather than validated. It has a known false-NEGATIVE
 * class as well: this repository's own `GEMINI_API_KEY` is read as
 * `env["GEMINI_API_KEY"]` off a passed-in object (`design-capability.ts`), which
 * none of the patterns match, and neither would `dotenv` config or destructuring.
 *
 * That is exactly why it may only ever SUGGEST. It cannot block a run, cannot
 * create a store entry, and cannot make the box mandatory; the worst a false
 * positive does is add one row to a list the owner is already reading, and the
 * worst a false negative does is leave them to type the name themselves.
 */
const SECRETISH_NAME_RE = /(?:_KEY|_TOKEN|_SECRET|SECRET_|_PASSWORD|_CREDENTIALS?|_DSN|_WEBHOOK)/;

/**
 * Names the scan must never suggest even when they match the shape above:
 * this program's own configuration, and the metered credentials it strips.
 */
const NEVER_SUGGEST: readonly string[] = Object.freeze([
  ...STRIPPED_ENV_NAMES,
  "DASHBOARD_HOME",
  "DASHBOARD_HOST",
  "DASHBOARD_PORT",
  "BAKEOFF_SCORER_IMAGE",
  "BAKEOFF_SCORER_TIMEOUT_MIN",
  "BAKEOFF_RESULTS_DIR",
  "BAKEOFF_ACCEPTANCE_ROOT",
]);

/** Where an env read was seen. `file` is artefact-relative; no line content. */
export interface EnvRead {
  readonly name: string;
  readonly file: string;
}

const SCANNED_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue", ".astro"];
const SKIPPED_DIRS: readonly string[] = ["node_modules", ".git", ".next", "dist", "build", "coverage", ".design-tmp"];
/** Bounded so a scan cannot become the slowest thing in an HTTP handler. */
const MAX_SCANNED_FILES = 2000;
const MAX_SCANNED_BYTES = 512 * 1024;

/**
 * Comments removed, so prose about `process.env.FOO` is not counted as a read.
 *
 * MEASURED NECESSITY, NOT TIDINESS: both surviving false positives in the table
 * above came from doc comments. Deliberately crude — a `//` inside a string
 * literal (a URL) drops the rest of that line, which can lose a genuine read
 * that shares the line. That trade was taken knowingly: the cost of the loss is
 * one missing SUGGESTION, and the cost of the false positive is a row that tells
 * the owner their code needs a credential it does not need.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Every `process.env.NAME` / `import.meta.env.NAME` / `Deno.env.get("NAME")`
 * read in a directory tree. UNFILTERED by name shape — this is the raw
 * measurement, and {@link inferredSecretNames} is what a caller should use.
 *
 * `includeComments: true` is the negative-control arm: it is what produced the
 * "before" column of the measurement in {@link SECRETISH_NAME_RE}'s comment, and
 * the test file runs both arms so the claim that stripping changes the answer is
 * executed rather than asserted.
 */
export function scanEnvReads(
  dir: string,
  options: { readonly includeComments?: boolean } = {},
): readonly EnvRead[] {
  const found: EnvRead[] = [];
  if (!existsSync(dir)) return found;
  let scanned = 0;
  const patterns: readonly RegExp[] = [
    /process\.env\.([A-Z][A-Z0-9_]{0,63})\b/g,
    /process\.env\[\s*["'`]([A-Z][A-Z0-9_]{0,63})["'`]\s*\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]{0,63})\b/g,
    /Deno\.env\.get\(\s*["'`]([A-Z][A-Z0-9_]{0,63})["'`]\s*\)/g,
  ];

  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_SCANNED_FILES) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      let text: string;
      try {
        if (statSync(full).size > MAX_SCANNED_BYTES) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (options.includeComments !== true) text = stripComments(text);
      scanned += 1;
      const rel = relative(dir, full) || entry.name;
      for (const pattern of patterns) {
        const re = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null = re.exec(text);
        while (match !== null) {
          const name = match[1];
          if (name !== undefined) found.push({ name, file: rel });
          match = re.exec(text);
        }
      }
    }
  };

  walk(dir);
  return found;
}

/**
 * The suggestion the box may show: credential-shaped names an artefact reads
 * from its environment, minus this program's own configuration.
 *
 * INFERRED, AND THEREFORE NEVER A BLOCK. It cannot fail a run, cannot create a
 * store entry and cannot make the box mandatory; the worst a false positive can
 * do is put one name in a list the owner is already looking at. The direction was
 * chosen on the measurement in {@link SECRETISH_NAME_RE}'s comment: the raw scan
 * is 92.6% false positives on this repository, which is fine for a suggestion and
 * would be indefensible for a gate.
 */
export function inferredSecretNames(dir: string): readonly string[] {
  const names = new Set<string>();
  for (const read of scanEnvReads(dir)) {
    if (!SECRETISH_NAME_RE.test(read.name)) continue;
    if (NEVER_SUGGEST.includes(read.name)) continue;
    names.add(read.name);
  }
  return [...names].sort();
}

/* -------------------------------------------------------------------------
 * The status a route may send
 * ---------------------------------------------------------------------- */

/**
 * The one sentence about the gate that has to travel with this feature.
 *
 * Rendered in the box. A form that accepts a Stripe key looks exactly like a
 * promise that a Stripe-dependent criterion can now pass, and it cannot: the
 * sealed scorer runs `--network=none` and is handed a four-variable allowlist
 * that contains no credential (`paths.ts:183-195`).
 */
export const GATE_LIMIT_NOTE =
  "The sealed grader runs with no network and is given no credentials. A value stored here can be " +
  "read by the app while it is being built and previewed on this machine; it can never let the " +
  "grader verify anything that needs a live third-party service.";

/** One row in the box. `present` is presence — there is no value field, ever. */
export interface SecretRequirement {
  readonly name: string;
  /** `stored`: on file already. `inferred`: seen in the artefact's source. */
  readonly source: "stored" | "inferred";
  readonly present: boolean;
  /** Owner-facing reason this row is on screen. Never contains a value. */
  readonly why: string;
}

/**
 * What `GET /api/secrets` and `GET /api/runs/:id/secrets` send.
 *
 * NO VALUE FIELD EXISTS ON THIS TYPE. That is the point of the type: a future
 * edit that tries to send one has to add a field, in a file whose tests assert
 * the key set, rather than widen an existing string.
 */
export interface SecretIntakeStatus {
  /** Absolute path of the store, so the owner can see where it went. */
  readonly storePath: string;
  /** 0600 when the file exists, null when it does not. Reported, not implied. */
  readonly storeMode: string | null;
  readonly runtimeDeclared: DeclaredRuntimeMode;
  readonly requirements: readonly SecretRequirement[];
  readonly gateNote: string;
}

export function secretIntakeStatus(options: {
  readonly file: string;
  readonly runtimeDeclared?: DeclaredRuntimeMode;
  readonly inferredFrom?: string | null;
}): SecretIntakeStatus {
  const stored = storedSecretNames(options.file);
  const requirements: SecretRequirement[] = stored.map((name) => ({
    name,
    source: "stored" as const,
    present: true,
    why: "stored on this machine by you. The value is never shown again, here or anywhere.",
  }));
  const inferred =
    options.inferredFrom === undefined || options.inferredFrom === null
      ? []
      : inferredSecretNames(options.inferredFrom);
  for (const name of inferred) {
    if (stored.includes(name)) continue;
    requirements.push({
      name,
      source: "inferred",
      present: false,
      why:
        "the code reads this from its environment and nothing has been stored for it. This is a " +
        "guess from the source, not something the spec declared — ignore it if it is wrong.",
    });
  }
  const mode = fileMode(options.file);
  return {
    storePath: options.file,
    storeMode: mode === null ? null : `0${mode.toString(8)}`,
    runtimeDeclared: options.runtimeDeclared ?? "unknown",
    requirements,
    gateNote: GATE_LIMIT_NOTE,
  };
}
