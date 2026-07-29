/**
 * contract-parity.test.ts — THE SSE EVENT UNION, ACROSS THE PACKAGE BOUNDARY.
 *
 * THE HOLE THIS CLOSES, AND THE ONE IT DOES NOT. `use-run-stream.ts` already
 * carries a type-level guard proving that every member of the CLIENT's
 * `RunEventType` has a listener in `EVENT_TYPES`; deleting a member from that
 * array fails the client build, and that was measured. But the guard is
 * one-directional: adding a member to the SERVER's `SseEvent` union alone stayed
 * GREEN everywhere, because the client's `RunEventType` is a hand-written mirror
 * and a mirror that has never heard of an event type is a perfectly valid type.
 * The server could grow an event the client never listens for, never parses and
 * never renders — the blank-canvas failure the client guard exists to prevent,
 * approached from the side nothing watched.
 *
 * WHY A TEST THAT READS THE OTHER PACKAGE'S SOURCE, AND NOT SOMETHING TIDIER.
 * `dashboard/src` and `dashboard/server` are separate TypeScript programs with
 * separate tsconfigs and no path from either to the other, so `Exclude` cannot
 * span them; a type is erased by the time any test could run; and a generated
 * manifest checked in on both sides would be a fifth declaration site with the
 * same drift problem one layer down. The one thing that genuinely fails is a
 * check that reads what the client actually declares.
 *
 * ONE SIDE IS IMPORTED, THE OTHER IS PARSED, AND THAT ASYMMETRY IS DELIBERATE.
 * The server side is `SSE_EVENT_TYPES` — a real value, imported, and proven
 * complete against `SseEvent` by the `Exclude` guard next to it, so no regex can
 * fake it. Only the client side is read as text. A both-sides-textual comparison
 * could pass by matching nothing on both sides.
 *
 * WHAT IT COVERS: the three hand-maintained client declaration sites named
 * below, by NAME, in both directions — a name the server has and the client does
 * not, and a name the client has and the server does not, both fail.
 *
 * WHAT IT DOES NOT COVER: shapes. It compares the `type` discriminators and
 * nothing else, so a client `graph_result` whose `totalTokens` is typed `number`
 * where the server sends `number | null` still passes here. It also does not
 * prove a `case` in `parseRunEvent` builds a correct event — only that the label
 * exists, which is the difference between "dropped silently" and "handled".
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SSE_EVENT_TYPES } from "./api-types.js";

/**
 * The client package, from the COMPILED location of this file.
 *
 * `import.meta.dirname` is `dashboard/server/<outDir>` at run time, so the client
 * lives two directories up. Every outDir this repo uses sits at that same depth
 * for exactly this reason. If the file is not there the check FAILS rather than
 * skips — a parity check that quietly stops finding the other package is the
 * purest can't-fail check there is.
 */
const CLIENT_LIB = join(import.meta.dirname, "..", "..", "src", "lib");
const CLIENT_TYPES = join(CLIENT_LIB, "api-types.ts");
const CLIENT_STREAM = join(CLIENT_LIB, "use-run-stream.ts");

/** The server's list, widened once so it can be compared against parsed text. */
const SERVER: readonly string[] = SSE_EVENT_TYPES;

function readClient(file: string): string {
  assert.ok(
    existsSync(file),
    `this check reads the client package and it is not at ${file}. The client moved, ` +
      `or this test is running from an outDir that is not directly under dashboard/server.`,
  );
  return readFileSync(file, "utf8");
}

/** Block comments first, then line comments: a slash-slash inside a block comment is prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * The text between two anchors, with comments removed.
 *
 * A MISSING ANCHOR THROWS. It must never yield the empty string: an empty region
 * matches no literals, and "no literals found" would read as agreement in the
 * one direction that matters least and as a confusing failure in the other. A
 * throw names the file and the anchor, so a client refactor reads as a client
 * refactor.
 */
function region(source: string, file: string, open: string, close: string): string {
  const start = source.indexOf(open);
  assert.notEqual(
    start,
    -1,
    `${file}: the anchor \`${open}\` is gone. This check parses that declaration; ` +
      `re-point it at whatever replaced it rather than deleting the check.`,
  );
  const from = start + open.length;
  const end = source.indexOf(close, from);
  assert.notEqual(
    end,
    -1,
    `${file}: the anchor \`${open}\` has no closing \`${close}\`.`,
  );
  return withoutComments(source.slice(from, end));
}

function literals(text: string, pattern: RegExp): readonly string[] {
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** Names the drift in both directions instead of dumping two lists. */
function drift(found: readonly string[], what: string): string {
  const missing = SERVER.filter((type) => !found.includes(type));
  const extra = found.filter((type) => !SERVER.includes(type));
  const parts = [
    missing.length > 0
      ? `the server sends ${missing.join(", ")} and ${what} does not name ${
          missing.length === 1 ? "it" : "them"
        }`
      : "",
    extra.length > 0 ? `${what} names ${extra.join(", ")}, which the server never sends` : "",
  ].filter((part) => part.length > 0);
  return `SSE union drift: ${
    parts.length > 0 ? parts.join("; ") : "the same names in a different multiplicity"
  }. The server's union is api-types.ts::SseEvent; the client mirrors it by hand in three places and nothing but this test compares them.`;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

test("CONTRACT: the client's RunEvent union names exactly the server's SseEvent members", () => {
  const union = region(
    readClient(CLIENT_TYPES),
    CLIENT_TYPES,
    "export type RunEvent =",
    "\nexport ",
  );
  // Anchored on `type:` so that `"preloaded"`, `"allow"`, `"deny"` and the rest
  // of the payload literals in the same block are not collected as event types.
  const found = literals(union, /\btype:\s*"([a-z_]+)"/g);
  assert.deepEqual(sorted(found), sorted(SERVER), drift(found, "the client's RunEvent union"));
});

test("CONTRACT: the client registers an SSE listener for every server event type", () => {
  // THE ONE WITH TEETH. `attachSse` writes NAMED events (`event: graph_tool`),
  // and EventSource delivers a named event only to a listener registered for
  // that exact name — so an event type absent from `EVENT_TYPES` is not merely
  // unrendered, it is never received, on a connection that stays open and looks
  // healthy.
  const listeners = region(
    readClient(CLIENT_STREAM),
    CLIENT_STREAM,
    "const EVENT_TYPES = [",
    "] as const",
  );
  const found = literals(listeners, /"([a-z_]+)"/g);
  assert.deepEqual(sorted(found), sorted(SERVER), drift(found, "the client's EVENT_TYPES"));
});

test("CONTRACT: parseRunEvent has a case for every server event type", () => {
  // The third site, and the one the client's own type-level guard explicitly
  // cannot reach: `type` inside that switch is `string | null`, so no
  // exhaustiveness check is available and a missing arm falls through
  // `default: return null`. The event arrives, is dropped, and the canvas
  // renders empty with a clean compile on both sides.
  const parser = region(
    readClient(CLIENT_STREAM),
    CLIENT_STREAM,
    "export function parseRunEvent(",
    "\nexport ",
  );
  const found = literals(parser, /\bcase\s+"([a-z_]+)"\s*:/g);
  assert.deepEqual(sorted(found), sorted(SERVER), drift(found, "parseRunEvent's switch"));
});

/* -------------------------------------------------------------------------
 * RunDetail.designLock — the field the three event-type tests above cannot see
 *
 * Everything above compares EVENT TYPES. Nothing anywhere compares `RunDetail`
 * across the two packages, so a field added to the server's `RunDetail` and
 * forgotten in `dashboard/src/lib/api-types.ts` compiles clean on BOTH sides,
 * is serialised by the server, arrives at the browser, and simply never renders
 * — with no test, no typecheck and no lint saying anything. That asymmetry was
 * measured for this field (Task 11 Step 5 control 1): both typechecks stay
 * green and only these tests go red.
 *
 * ONE SIDE TEXTUAL, THE OTHER HARDCODED, for the same reason as above: the
 * expected shape is spelled out here as literals, so deleting the field from
 * BOTH packages cannot pass by matching nothing on both sides.
 * ---------------------------------------------------------------------- */

test("CONTRACT: the client's RunDetail declares designLock, with the server's shape", () => {
  const client = readClient(CLIENT_TYPES);

  const detail = region(client, CLIENT_TYPES, "export interface RunDetail extends RunSummary {", "\nexport ");
  assert.match(
    detail,
    /readonly designLock: DesignLockState \| null;/,
    "the client's RunDetail mirror has no designLock field: the server sends it and the UI cannot see it",
  );

  const state = region(client, CLIENT_TYPES, "export interface DesignLockState {", "}");
  // THE PARSE IS VERIFIED, NOT ASSUMED. This region closes on the FIRST `}`, so
  // a member that ever spans braces — an inlined object literal for `mockups`,
  // say — truncates it. The field checks below would then go red naming the
  // wrong cause ("the client is missing `reason`") when the real fault is this
  // parser. Counting first makes the truncation say so itself.
  assert.equal(
    state.split(";").length - 1,
    5,
    "the DesignLockState region did not parse as five fields — re-point this parser, do not delete it",
  );
  for (const field of [
    /readonly awaiting: boolean;/,
    /readonly mockups: readonly Screenshot\[\];/,
    /readonly locked: string \| null;/,
    /readonly lockedBy: "owner" \| "ui-designer" \| "fallback" \| null;/,
    /readonly reason: string \| null;/,
  ]) {
    assert.match(state, field, `the client's DesignLockState is missing ${String(field)}`);
  }

  const create = region(client, CLIENT_TYPES, "export interface CreateRunRequest {", "}");
  assert.match(
    create,
    /designLock\?: "auto" \| "ask" \| null;/,
    "the client cannot ask for a lock policy it does not declare",
  );
});

test("CONTRACT: the client sends designLock explicitly while there is no card UI", () => {
  // NOT COVERED 1: no mockup-card component ships in this phase. `interactive`
  // is true for a dashboard-submitted run, so `designLockPolicy` would return
  // "ask" and every web-UI ticket the owner submits from the dashboard would
  // park for the full timeout with nothing in the UI able to unpark it. Two
  // individually-correct decisions, joined into a 30-minute stall.
  //
  // Comments are stripped first: the explanation ABOVE that line in api.ts must
  // not be what satisfies this check.
  const api = join(CLIENT_LIB, "api.ts");
  assert.match(
    withoutComments(readClient(api)),
    /designLock: "auto"/,
    "a dashboard-submitted run would park with nothing able to resume it",
  );
});
