/**
 * tickets.ts — the six frozen reference tickets, and the freeze.
 *
 * doc 03 section 7.1: six reference tickets, two trivial, two medium, two hard.
 * "Freeze the ticket text verbatim. NEVER edit it between runs. Store a hash."
 *
 * WHY THE FREEZE IS LOAD-BEARING, NOT HOUSEKEEPING.
 * The bake-off's whole output is a comparison: five configurations against the
 * same six briefs. The brief is the ONLY input the builder receives, so a brief
 * that changes between run 4 and run 17 changes the thing being measured while
 * the results table goes on claiming the runs are comparable. Nothing downstream
 * can detect that after the fact — the pass rate simply moves and the move is
 * attributed to the model. A one-word edit to clarify a brief is exactly the
 * plausible, well-intentioned change that destroys a $3,170 experiment, so this
 * module is built to make it impossible to do quietly:
 *
 *   - {@link loadTickets} recomputes every digest from the bytes on disk and
 *     never consults the freeze file, so compute and compare stay separate;
 *   - {@link verifyFrozen} throws a {@link TicketFreezeError} naming every
 *     drifted ticket with both digests;
 *   - {@link freezeTickets} is idempotent when nothing changed and REFUSES to
 *     overwrite a freeze that no longer matches. There is deliberately no force
 *     flag: re-freezing is a decision to discard every result already collected,
 *     and that decision should cost a deliberate `rm`.
 *
 * WHAT THE BUILDER SEES. `Ticket.brief` and nothing else — see
 * {@link briefForBuilder}. Not the filename, not the frontmatter, not the tier,
 * not the title. A real user does not hand you a difficulty label, and a builder
 * told "tier: trivial" is a builder whose effort was set by the harness rather
 * than measured by it.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BAKEOFF_SCHEMA_VERSION, BakeoffError } from "./contracts.js";
import type { BakeoffErrorCode, Ticket, TicketTier } from "./contracts.js";
import { REFERENCE_TICKET_SLOTS } from "./config.js";
import { canonicalJsonDigest, ticketDigest } from "./hash.js";
import { assertRedacted } from "./redact.js";

/* -------------------------------------------------------------------------
 * Locations and constants
 * ---------------------------------------------------------------------- */

/**
 * The tickets directory: a sibling of the module's own directory, so it
 * resolves identically from `src/` and from the compiled `dist/`.
 */
export const TICKETS_DIR: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tickets");

/** The freeze file, written inside the tickets directory. */
export const FROZEN_BASENAME = "FROZEN.json";

/** Version of the {@link TicketFreeze} record shape. */
export const TICKET_FREEZE_SCHEMA_VERSION = BAKEOFF_SCHEMA_VERSION;

/** The only frontmatter keys a ticket file may carry. All three are required. */
export const TICKET_FRONTMATTER_KEYS: readonly string[] = Object.freeze(["id", "tier", "title"]);

/** Files in the tickets directory that are documentation, not tickets. */
const NON_TICKET_MARKDOWN = new Set(["readme.md"]);

/**
 * THE NORMATIVE BRIEF-EXTRACTION RULE. Recorded in the freeze file so that a
 * future reimplementation cannot quietly change it.
 *
 * A reimplementation that trims the brief, or converts newlines, or strips a
 * trailing blank line, changes all six digests at once WITHOUT any error firing
 * — the freeze would simply refuse the whole set and look like tamper. Hence the
 * rule is stated once, here, and shipped inside every freeze file.
 */
export const TICKET_BRIEF_EXTRACTION_RULE =
  "sha256 of the ticket brief: every byte of the file after the newline that terminates the closing " +
  '"---" frontmatter fence, taken as raw UTF-8 with NO normalisation — no trimming, no newline ' +
  "conversion, no Unicode normalisation, no BOM stripping. Files containing CR, NUL or a BOM are " +
  "rejected at load rather than normalised.";

const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";
/** Index to start searching for the closing fence: the LF of the opening fence. */
const CLOSE_SEARCH_START = FRONTMATTER_OPEN.length - 1;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const TICKET_ID_RE = /^T[1-9][0-9]*$/;
const KEY_VALUE_RE = /^([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/;
/** YAML indicator characters that would mean this is not a plain scalar. */
const YAML_INDICATOR_RE = /^[[\]{}&*!|>%@`#,]/;

const TIERS: readonly TicketTier[] = Object.freeze(["trivial", "medium", "hard"]);

/** A brief shorter than this is a placeholder, not a ticket. */
const MIN_BRIEF_NON_WHITESPACE_CHARS = 80;

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

/**
 * A ticket as loaded from disk. `sourcePath` and `briefBytes` are harness-side
 * bookkeeping and are NEVER shown to a builder; the {@link Ticket} fields are
 * the frozen contract.
 */
export interface LoadedTicket extends Ticket {
  /** Absolute path of the markdown file the brief came from. */
  readonly sourcePath: string;
  /** Length of the brief in UTF-8 bytes. Reported, never hashed. */
  readonly briefBytes: number;
}

/** How one ticket departs from the freeze. */
export type TicketDriftKind =
  /** The brief's bytes changed since the freeze. The campaign-invalidating one. */
  | "brief_changed"
  /** A ticket in the freeze has no file on disk. */
  | "ticket_missing_from_disk"
  /** A ticket on disk was never frozen. */
  | "ticket_not_in_freeze";

export interface TicketDrift {
  readonly ticketId: string;
  readonly kind: TicketDriftKind;
  /** Digest recorded in the freeze, or null when the ticket was never frozen. */
  readonly frozenSha256: string | null;
  /** Digest of the bytes on disk now, or null when there is no file. */
  readonly actualSha256: string | null;
  /** Absolute path, or null when there is no file. */
  readonly sourcePath: string | null;
}

/**
 * Raised when the frozen ticket set and the bytes on disk disagree, or when the
 * set was never frozen at all.
 *
 * Extends {@link BakeoffError} so the CLI's fail-clean path prints a code, a
 * message and a remediation instead of a stack trace. It reuses the
 * `suite_hash_mismatch` code — the closed union in the frozen contracts has no
 * ticket-specific member and must not be edited — and adds {@link kind} and
 * {@link drifts} so a consumer can tell a drifted ticket from a tampered
 * acceptance suite without parsing the message.
 */
export class TicketFreezeError extends BakeoffError {
  /** `"drift"` when digests disagree, `"not_frozen"` when there is no freeze. */
  readonly kind: "drift" | "not_frozen" | "corrupt_freeze";
  readonly drifts: readonly TicketDrift[];

  constructor(
    code: BakeoffErrorCode,
    kind: "drift" | "not_frozen" | "corrupt_freeze",
    message: string,
    remediation: string,
    drifts: readonly TicketDrift[] = [],
  ) {
    super(code, message, remediation);
    this.name = "TicketFreezeError";
    this.kind = kind;
    this.drifts = drifts;
  }
}

/**
 * The freeze file: `tickets/FROZEN.json`.
 *
 * `tickets` is the mapping the protocol asks for — ticket id to the sha256 of
 * its verbatim brief. Everything else exists so the file can be audited without
 * this source tree.
 */
export interface TicketFreeze {
  readonly schemaVersion: typeof BAKEOFF_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  /** The brief-extraction rule the digests were computed under. */
  readonly digestScope: string;
  /** ISO-8601 instant the set was frozen. */
  readonly frozenAt: string;
  /** ticket id -> sha256 hex of the verbatim brief. */
  readonly tickets: Readonly<Record<string, string>>;
  /**
   * Digest over the whole map, so that hand-editing one entry to match an edited
   * brief does not silently produce a self-consistent freeze file.
   */
  readonly setDigest: string;
}

/** What {@link verifyFrozen} returns when everything matches. */
export interface VerifiedTicketSet {
  readonly freeze: TicketFreeze;
  /** The tickets as loaded, in {@link REFERENCE_TICKET_SLOTS} order. */
  readonly tickets: readonly LoadedTicket[];
}

/* -------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------- */

function shapeError(message: string, remediation: string): BakeoffError {
  return new BakeoffError("invalid_usage_shape", message, remediation);
}

function readTicketFileText(absolutePath: string): string {
  const raw = readFileSync(absolutePath);
  const text = raw.toString("utf8");
  if (Buffer.compare(Buffer.from(text, "utf8"), raw) !== 0) {
    throw shapeError(
      `${absolutePath} is not valid UTF-8`,
      "Re-save the ticket as UTF-8. Decoding replaced at least one byte, so the digest would cover " +
        "different bytes than the file holds — the freeze would be meaningless.",
    );
  }
  return text;
}

function assertNoHostileBytes(text: string, sourcePath: string): void {
  if (text.charCodeAt(0) === 0xfeff) {
    throw shapeError(
      `${sourcePath} starts with a UTF-8 byte-order mark`,
      "Remove the BOM. The brief is hashed over raw bytes with no normalisation, so an editor that " +
        "adds a BOM changes the digest of a brief whose text nobody touched.",
    );
  }
  if (text.includes("\r")) {
    throw shapeError(
      `${sourcePath} contains a carriage return`,
      "Save the file with LF line endings. Ticket digests cover raw bytes: a CRLF checkout or a " +
        "Windows editor would change every digest at once without a word of the brief changing. " +
        "tickets/.gitattributes pins `-text` for this directory; this check covers the editor path.",
    );
  }
  if (text.includes("\0")) {
    throw shapeError(`${sourcePath} contains a NUL byte`, "Ticket briefs are plain text. Remove it.");
  }
}

/** Parse one frontmatter scalar. Deliberately tiny: it accepts or it throws. */
function parseScalar(rawValue: string, key: string, sourcePath: string): string {
  const value = rawValue.replace(/[ \t]+$/u, "");
  if (value.length === 0) {
    throw shapeError(
      `${sourcePath}: frontmatter key "${key}" has an empty value`,
      `Give "${key}" a value. All of ${TICKET_FRONTMATTER_KEYS.join(", ")} are required.`,
    );
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw shapeError(
        `${sourcePath}: frontmatter key "${key}" opens a double quote it never closes`,
        "Close the quote, or drop both quotes and use a plain value.",
      );
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw shapeError(
        `${sourcePath}: frontmatter key "${key}" is not a valid double-quoted string`,
        "Use JSON string escaping inside double quotes, or drop the quotes.",
      );
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw shapeError(
        `${sourcePath}: frontmatter key "${key}" opens a single quote it never closes`,
        "Close the quote, or drop both quotes and use a plain value.",
      );
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (YAML_INDICATOR_RE.test(value)) {
    throw shapeError(
      `${sourcePath}: frontmatter key "${key}" starts with the YAML indicator "${value.slice(0, 1)}"`,
      "Ticket frontmatter holds three plain scalars and nothing else. Quote the value if it really " +
        "needs to start with that character. This parser refuses structures rather than guessing at " +
        "them: a ticket set that loads differently under two YAML libraries is not frozen.",
    );
  }
  if (value.includes(": ")) {
    throw shapeError(
      `${sourcePath}: frontmatter key "${key}" contains ": ", which is ambiguous unquoted YAML`,
      'Wrap the value in double quotes, e.g. title: "Golf: the app".',
    );
  }
  return value;
}

function parseFrontmatter(block: string, sourcePath: string): Readonly<Record<string, string>> {
  const found = new Map<string, string>();
  const lines = block.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;

    const match = KEY_VALUE_RE.exec(line);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (match === null || key === undefined || rawValue === undefined) {
      throw shapeError(
        `${sourcePath}: frontmatter line ${i + 1} is not "key: value" — ${JSON.stringify(line)}`,
        `Ticket frontmatter is exactly ${TICKET_FRONTMATTER_KEYS.join(", ")}, one per line.`,
      );
    }
    if (!TICKET_FRONTMATTER_KEYS.includes(key)) {
      throw shapeError(
        `${sourcePath}: unknown frontmatter key "${key}"`,
        `Only ${TICKET_FRONTMATTER_KEYS.join(", ")} are allowed. Anything a builder must know belongs ` +
          "in the brief, because the brief is the only thing a builder is given; anything the harness " +
          "must know belongs in src/config.ts, because frontmatter is not covered by the digest.",
      );
    }
    if (found.has(key)) {
      throw shapeError(
        `${sourcePath}: frontmatter key "${key}" appears twice`,
        "Remove the duplicate. Which one wins would depend on the parser, and the ticket set must " +
          "load identically everywhere.",
      );
    }
    found.set(key, parseScalar(rawValue, key, sourcePath));
  }

  for (const key of TICKET_FRONTMATTER_KEYS) {
    if (!found.has(key)) {
      throw shapeError(
        `${sourcePath}: frontmatter is missing required key "${key}"`,
        `Ticket frontmatter requires ${TICKET_FRONTMATTER_KEYS.join(", ")}.`,
      );
    }
  }
  return Object.fromEntries(found);
}

function assertBriefCarriesNoCredential(brief: string, ticketId: string, sourcePath: string): void {
  try {
    assertRedacted(brief);
  } catch (error) {
    const detail = error instanceof BakeoffError ? error.message : "credential-shaped text";
    throw shapeError(
      `ticket ${ticketId} (${sourcePath}): the text matches a credential pattern — ${detail}`,
      "Remove it from the brief and ROTATE it. A brief is sent verbatim to every vendor in the " +
        "matrix, hashed into the freeze file and copied into every run record — a secret in a brief " +
        "is a secret in the permanent record. The offending value is deliberately not quoted here.",
    );
  }
}

/**
 * Parse one ticket file.
 *
 * Exported so the extraction rule can be exercised directly on text. The digest
 * it computes is the digest the freeze records, with no separate code path.
 */
export function parseTicketFile(fileText: string, sourcePath: string): LoadedTicket {
  assertNoHostileBytes(fileText, sourcePath);

  if (!fileText.startsWith(FRONTMATTER_OPEN)) {
    throw shapeError(
      `${sourcePath} does not start with a "---" frontmatter fence`,
      'A ticket file starts with "---" on its own line, then id / tier / title, then "---" on its ' +
        "own line, then the brief.",
    );
  }
  const closeIndex = fileText.indexOf(FRONTMATTER_CLOSE, CLOSE_SEARCH_START);
  if (closeIndex < 0) {
    throw shapeError(
      `${sourcePath} has no closing "---" frontmatter fence`,
      'Close the frontmatter with "---" on its own line. Everything after it is the verbatim brief.',
    );
  }

  const front = parseFrontmatter(fileText.slice(FRONTMATTER_OPEN.length, closeIndex), sourcePath);
  const brief = fileText.slice(closeIndex + FRONTMATTER_CLOSE.length);

  const id = front["id"] ?? "";
  const tier = front["tier"] ?? "";
  const title = front["title"] ?? "";

  if (!TICKET_ID_RE.test(id)) {
    throw shapeError(
      `${sourcePath}: ticket id "${id}" is not of the form T1, T2, ...`,
      `Use one of the reference slot ids: ${REFERENCE_TICKET_SLOTS.map((s) => s.id).join(", ")}.`,
    );
  }
  if (!TIERS.includes(tier as TicketTier)) {
    throw shapeError(
      `${sourcePath}: ticket ${id} has tier "${tier}"`,
      `tier must be one of ${TIERS.join(", ")}.`,
    );
  }
  if (title.includes("\n")) {
    throw shapeError(`${sourcePath}: ticket ${id} has a multi-line title`, "Titles are one line.");
  }

  if (brief.replace(/\s/gu, "").length < MIN_BRIEF_NON_WHITESPACE_CHARS) {
    throw shapeError(
      `${sourcePath}: ticket ${id} has an empty or near-empty brief`,
      "The brief is the only input a builder receives. A stub brief measures nothing: every " +
        "configuration would fail identically and the run would cost money to learn that.",
    );
  }

  assertBriefCarriesNoCredential(brief, id, sourcePath);
  assertBriefCarriesNoCredential(title, id, sourcePath);

  return {
    id,
    tier: tier as TicketTier,
    title,
    brief,
    sha256: ticketDigest(brief),
    sourcePath,
    briefBytes: Buffer.byteLength(brief, "utf8"),
  };
}

/* -------------------------------------------------------------------------
 * Loading
 * ---------------------------------------------------------------------- */

/**
 * Load, validate and digest the six reference tickets.
 *
 * Reads ONLY the markdown files. It never opens `FROZEN.json`: computing the
 * digests and comparing them against the freeze are separate operations on
 * purpose, because a loader that fell back to the recorded digest could not
 * detect the one thing this module exists to detect.
 *
 * Returns the tickets in {@link REFERENCE_TICKET_SLOTS} order, not directory
 * order, so that anything derived from the list — run ordering, report rows, a
 * set digest — is independent of how the filesystem happens to enumerate.
 */
export function loadTickets(dir: string = TICKETS_DIR): readonly LoadedTicket[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw shapeError(
      `cannot read the tickets directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      "Create the directory and put the six frozen reference briefs in it, or pass the correct path.",
    );
  }

  const markdown = entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .filter((name) => !NON_TICKET_MARKDOWN.has(name.toLowerCase()))
    .sort();

  const byId = new Map<string, LoadedTicket>();
  for (const name of markdown) {
    const absolutePath = join(dir, name);
    const ticket = parseTicketFile(readTicketFileText(absolutePath), absolutePath);
    const clash = byId.get(ticket.id);
    if (clash !== undefined) {
      throw shapeError(
        `two files declare ticket ${ticket.id}: ${clash.sourcePath} and ${ticket.sourcePath}`,
        "One file per ticket id. Which one a run used would otherwise depend on directory ordering.",
      );
    }
    byId.set(ticket.id, ticket);
  }

  const problems: string[] = [];
  for (const slot of REFERENCE_TICKET_SLOTS) {
    const ticket = byId.get(slot.id);
    if (ticket === undefined) {
      problems.push(`${slot.id} (${slot.tier}) is missing: ${slot.purpose}`);
      continue;
    }
    if (ticket.tier !== slot.tier) {
      problems.push(
        `${slot.id} is tier "${ticket.tier}" but REFERENCE_TICKET_SLOTS declares "${slot.tier}"`,
      );
    }
  }
  const slotIds = new Set(REFERENCE_TICKET_SLOTS.map((s) => s.id));
  for (const id of byId.keys()) {
    if (!slotIds.has(id)) {
      problems.push(`${id} is not one of the six reference slots (${[...slotIds].join(", ")})`);
    }
  }
  if (problems.length > 0) {
    throw shapeError(
      `the ticket set in ${dir} does not match REFERENCE_TICKET_SLOTS:\n  - ${problems.join("\n  - ")}`,
      "doc 03 section 7.1 fixes the set at six: two trivial, two medium, two hard. Six is the " +
        "denominator every rate in the results table is computed over; a set of five or seven is a " +
        "different experiment. Fix the files, or change REFERENCE_TICKET_SLOTS in src/config.ts and " +
        "accept that no earlier result is comparable.",
    );
  }

  return REFERENCE_TICKET_SLOTS.map((slot) => byId.get(slot.id) as LoadedTicket);
}

/**
 * THE ONLY THING A BUILDER IS GIVEN.
 *
 * Not the file, not the frontmatter, not the filename, not the tier, not the
 * title. A real user hands over a paragraph of what they want, not a difficulty
 * label; a builder told "tier: trivial" has had its effort set by the harness
 * rather than measured by it, and the title is a summary the harness wrote.
 * Route every builder prompt through here.
 */
export function briefForBuilder(ticket: Ticket): string {
  return ticket.brief;
}

/* -------------------------------------------------------------------------
 * The freeze
 * ---------------------------------------------------------------------- */

function ticketDigestMap(tickets: readonly Ticket[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const ticket of tickets) map[ticket.id] = ticket.sha256;
  return map;
}

/**
 * Digest over the whole frozen set. Order-independent (canonical JSON sorts
 * keys), so it identifies the ticket SET in a report or a run record without
 * depending on how the tickets were enumerated.
 */
export function ticketSetDigest(tickets: readonly Ticket[]): string {
  return canonicalJsonDigest({
    digestVersion: 1,
    algorithm: "sha256",
    tickets: ticketDigestMap(tickets),
  });
}

function freezePath(dir: string): string {
  return join(dir, FROZEN_BASENAME);
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "corrupt_freeze",
      `${path}: field "${key}" is missing or not a string`,
      `Do not hand-edit ${FROZEN_BASENAME}. Delete it and re-freeze from the briefs.`,
    );
  }
  return value;
}

/**
 * Read and validate the freeze file.
 *
 * Recomputes `setDigest` from the recorded map: editing a single digest in
 * `FROZEN.json` to make it agree with an edited brief leaves the set digest
 * behind and is caught here. That does not make the file tamper-PROOF — a
 * determined editor can recompute it — but the freeze exists to stop a plausible
 * mistake, and "I fixed the hash so it would stop complaining" is the plausible
 * mistake.
 */
export function readFreeze(dir: string = TICKETS_DIR): TicketFreeze {
  const path = freezePath(dir);
  if (!existsSync(path)) {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "not_frozen",
      `no freeze file at ${path}`,
      "Freeze the ticket set before the first run: `npm run build && node dist/tickets-cli.js freeze`.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "corrupt_freeze",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      `Restore ${FROZEN_BASENAME} from version control. If no runs have been executed, delete it and re-freeze.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "corrupt_freeze",
      `${path} is not a JSON object`,
      `Restore ${FROZEN_BASENAME} from version control.`,
    );
  }
  const record = parsed as Record<string, unknown>;

  if (record["schemaVersion"] !== TICKET_FREEZE_SCHEMA_VERSION) {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "corrupt_freeze",
      `${path}: schemaVersion is ${JSON.stringify(record["schemaVersion"])}, expected ${TICKET_FREEZE_SCHEMA_VERSION}`,
      "This freeze was written by a different version of the harness. Do not mix them: re-freeze " +
        "only if no runs have been executed, and discard results collected under the old schema.",
    );
  }
  if (record["algorithm"] !== "sha256") {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "corrupt_freeze",
      `${path}: algorithm is ${JSON.stringify(record["algorithm"])}, expected "sha256"`,
      "Digests are sha256 over raw UTF-8 bytes. Re-freeze.",
    );
  }

  const rawTickets = record["tickets"];
  if (rawTickets === null || typeof rawTickets !== "object" || Array.isArray(rawTickets)) {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "corrupt_freeze",
      `${path}: "tickets" is not an object of id -> sha256`,
      `Delete ${FROZEN_BASENAME} and re-freeze from the briefs.`,
    );
  }
  const tickets: Record<string, string> = {};
  for (const [id, digest] of Object.entries(rawTickets as Record<string, unknown>)) {
    if (typeof digest !== "string" || !SHA256_HEX_RE.test(digest)) {
      throw new TicketFreezeError(
        "invalid_usage_shape",
        "corrupt_freeze",
        `${path}: ticket ${id} has a digest that is not 64 lowercase hex characters`,
        `Delete ${FROZEN_BASENAME} and re-freeze from the briefs.`,
      );
    }
    tickets[id] = digest;
  }

  const digestScope = requireString(record, "digestScope", path);
  const frozenAt = requireString(record, "frozenAt", path);
  const setDigest = requireString(record, "setDigest", path);

  const recomputed = canonicalJsonDigest({ digestVersion: 1, algorithm: "sha256", tickets });
  if (recomputed !== setDigest) {
    throw new TicketFreezeError(
      "suite_hash_mismatch",
      "corrupt_freeze",
      `${path}: setDigest ${setDigest} does not cover the recorded ticket digests (recomputed ${recomputed})`,
      "The freeze file was edited by hand. STOP: do not run or report anything against it. Restore " +
        "it from version control. Editing a recorded digest so that a changed brief stops failing " +
        "verification defeats the entire freeze — the runs before and after the edit measured " +
        "different inputs.",
    );
  }

  return {
    schemaVersion: TICKET_FREEZE_SCHEMA_VERSION,
    algorithm: "sha256",
    digestScope,
    frozenAt,
    tickets,
    setDigest,
  };
}

function diffAgainstFreeze(
  freeze: TicketFreeze,
  tickets: readonly LoadedTicket[],
): readonly TicketDrift[] {
  const drifts: TicketDrift[] = [];
  const onDisk = new Map(tickets.map((t) => [t.id, t]));

  for (const ticket of tickets) {
    const frozen = freeze.tickets[ticket.id];
    if (frozen === undefined) {
      drifts.push({
        ticketId: ticket.id,
        kind: "ticket_not_in_freeze",
        frozenSha256: null,
        actualSha256: ticket.sha256,
        sourcePath: ticket.sourcePath,
      });
    } else if (frozen !== ticket.sha256) {
      drifts.push({
        ticketId: ticket.id,
        kind: "brief_changed",
        frozenSha256: frozen,
        actualSha256: ticket.sha256,
        sourcePath: ticket.sourcePath,
      });
    }
  }

  for (const [id, frozen] of Object.entries(freeze.tickets)) {
    if (!onDisk.has(id)) {
      drifts.push({
        ticketId: id,
        kind: "ticket_missing_from_disk",
        frozenSha256: frozen,
        actualSha256: null,
        sourcePath: null,
      });
    }
  }

  return drifts.sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0));
}

const BANNER = "=".repeat(78);

const DRIFT_HEADLINE: Readonly<Record<TicketDriftKind, string>> = Object.freeze({
  brief_changed: "BRIEF TEXT CHANGED SINCE THE FREEZE",
  ticket_missing_from_disk: "FROZEN TICKET HAS NO FILE ON DISK",
  ticket_not_in_freeze: "TICKET ON DISK WAS NEVER FROZEN",
});

/** Render drift as an unmissable, digest-complete block. Never truncates a digest. */
export function formatTicketDrift(drifts: readonly TicketDrift[], freeze: TicketFreeze): string {
  const lines: string[] = [];
  lines.push(BANNER);
  lines.push("THE FROZEN TICKET SET CHANGED. EVERY COMPARISON IN THE BAKE-OFF IS NOW INVALID.");
  lines.push(BANNER);
  lines.push(`frozen at: ${freeze.frozenAt}`);
  lines.push(`set digest at freeze: ${freeze.setDigest}`);
  lines.push(`${drifts.length} ticket(s) drifted:`);
  for (const drift of drifts) {
    lines.push(`  ${drift.ticketId}  ${DRIFT_HEADLINE[drift.kind]}`);
    lines.push(`      frozen digest : ${drift.frozenSha256 ?? "(never frozen)"}`);
    lines.push(`      digest on disk: ${drift.actualSha256 ?? "(no file)"}`);
    lines.push(`      file          : ${drift.sourcePath ?? "(no file)"}`);
  }
  lines.push(BANNER);
  return lines.join("\n");
}

const DRIFT_REMEDIATION =
  "STOP. Do not start, score or report a run against this ticket set. Then pick ONE:\n" +
  "  (a) The change was accidental — restore the frozen bytes (`git checkout -- tickets/`) and " +
  "re-run verify. Nothing is lost.\n" +
  "  (b) The change was deliberate AND no run has been executed yet — delete tickets/FROZEN.json, " +
  "re-freeze, and note the new set digest in the experiment log.\n" +
  "  (c) The change was deliberate and runs HAVE been executed — every result collected under the " +
  "old freeze is now incomparable with anything collected after it. Archive the old results with " +
  "the old set digest, re-freeze, and restart the campaign. Do not merge the two sets.\n" +
  "There is deliberately no --force flag: doc 03 section 7.1 says the ticket text is frozen verbatim " +
  "and NEVER edited between runs, and a one-word clarification silently moves the pass rate that the " +
  "whole $3,170 campaign exists to measure.";

/**
 * Freeze the ticket set: write `tickets/FROZEN.json` mapping id -> sha256.
 *
 * - No freeze file yet: writes one and returns it.
 * - Freeze file present and every digest matches: returns the EXISTING record
 *   untouched, `frozenAt` and all. Idempotent, so it is safe in a preflight
 *   script; re-stamping the date would erase when the set was actually sealed.
 * - Freeze file present and any digest differs: throws {@link TicketFreezeError}.
 *   Re-freezing is a decision to discard collected results, so it costs a
 *   deliberate `rm tickets/FROZEN.json` and never a flag.
 */
export function freezeTickets(dir: string = TICKETS_DIR): TicketFreeze {
  const tickets = loadTickets(dir);
  const path = freezePath(dir);

  if (existsSync(path)) {
    const existing = readFreeze(dir);
    const drifts = diffAgainstFreeze(existing, tickets);
    if (drifts.length > 0) {
      throw new TicketFreezeError(
        "suite_hash_mismatch",
        "drift",
        `refusing to overwrite ${path}\n${formatTicketDrift(drifts, existing)}`,
        DRIFT_REMEDIATION,
        drifts,
      );
    }
    return existing;
  }

  const map = ticketDigestMap(tickets);
  const freeze: TicketFreeze = {
    schemaVersion: TICKET_FREEZE_SCHEMA_VERSION,
    algorithm: "sha256",
    digestScope: TICKET_BRIEF_EXTRACTION_RULE,
    frozenAt: new Date().toISOString(),
    tickets: map,
    setDigest: canonicalJsonDigest({ digestVersion: 1, algorithm: "sha256", tickets: map }),
  };
  writeFileSync(path, `${JSON.stringify(freeze, null, 2)}\n`, { encoding: "utf8" });
  return freeze;
}

/**
 * Verify the briefs on disk still match the freeze. Throws loudly if not.
 *
 * Call this at the start of every run, before every scoring pass and before
 * every report. It is cheap — six files and six digests — and it is the only
 * check that can tell you the experiment's inputs moved under it.
 */
export function verifyFrozen(dir: string = TICKETS_DIR): VerifiedTicketSet {
  const tickets = loadTickets(dir);
  const path = freezePath(dir);

  if (!existsSync(path)) {
    throw new TicketFreezeError(
      "invalid_usage_shape",
      "not_frozen",
      `the ticket set in ${dir} has never been frozen: no ${FROZEN_BASENAME}`,
      "Freeze it BEFORE the first run: `npm run build && node dist/tickets-cli.js freeze`. A run " +
        "against unfrozen briefs cannot be proved comparable with any other run, so it is not " +
        "evidence — it is spend.",
    );
  }

  const freeze = readFreeze(dir);
  const drifts = diffAgainstFreeze(freeze, tickets);
  if (drifts.length > 0) {
    throw new TicketFreezeError(
      "suite_hash_mismatch",
      "drift",
      formatTicketDrift(drifts, freeze),
      DRIFT_REMEDIATION,
      drifts,
    );
  }

  const actualSetDigest = ticketSetDigest(tickets);
  if (actualSetDigest !== freeze.setDigest) {
    throw new TicketFreezeError(
      "suite_hash_mismatch",
      "drift",
      `every ticket digest matches ${path} but the set digest does not: ${actualSetDigest} vs ${freeze.setDigest}`,
      "The freeze records a ticket the loader did not see, or vice versa. Investigate before running.",
      [],
    );
  }

  return { freeze, tickets };
}

/* -------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------- */

/**
 * One line per ticket: id, tier, digest, size, title. Never the brief — a
 * summary that prints briefs is a summary someone will paste into a builder's
 * context along with the tier label.
 */
export function formatTicketSummary(tickets: readonly LoadedTicket[]): string {
  const lines: string[] = [];
  lines.push("frozen reference tickets (doc 03 section 7.1)");
  for (const ticket of tickets) {
    lines.push(
      `  ${ticket.id}  ${ticket.tier.padEnd(7)}  ${ticket.sha256}  ${String(ticket.briefBytes).padStart(5)}B  ${ticket.title}`,
    );
  }
  lines.push(`  set digest: ${ticketSetDigest(tickets)}`);
  return lines.join("\n");
}
