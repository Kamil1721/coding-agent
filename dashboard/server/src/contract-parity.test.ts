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
 * IT NO LONGER COMPARES ONLY DISCRIMINATORS, AND THIS PARAGRAPH USED TO SAY IT
 * DID. That sentence was true when the file held three checks; it has since grown
 * per-field and whole-shape comparisons for `RunDetail`, the spend record and the
 * motion readout, and on 2026-08-04 it grew two more kinds of check again. The
 * scope, stated once and honestly:
 *
 *   · EVENT TYPE NAMES, across the three client sites (the original three tests).
 *   · FIELD SETS, in both directions, for `RunDetail` and its nested shapes, for
 *     the spend record, and now for the FOLDED CANVAS — `GraphState`, `GraphNode`,
 *     `GraphActivityEntry`, `GraphDiff` and the rest.
 *   · SELECTED FIELD TYPES, hand-written per shape, since the field-name
 *     comparison cannot see a client that typed `kind: string`.
 *   · THE FOLD'S ARMS — every event type this program claims to fold has a `case`
 *     in `graph.ts`. That is declaration site SIX, and until this check existed it
 *     was enforced by absolutely nothing: `foldGraph`'s `default:` returns the
 *     state unchanged, so an event with no arm is received, parsed, folded to
 *     nothing and rendered nowhere, with every other check in this file green.
 *
 * WHAT IT STILL DOES NOT COVER: whether a `case` builds a CORRECT event or a
 * correct fold. It sees a label. That is the difference between "dropped
 * silently" and "handled", which is the difference this file exists for, and it is
 * not the difference between "handled" and "handled right".
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SPEND_SEATS, SSE_EVENT_TYPES } from "./api-types.js";

/**
 * The client package, from the COMPILED location of this file.
 *
 * `import.meta.dirname` is `dashboard/server/<outDir>` at run time, so the client
 * lives two directories up. Every outDir this repo uses sits at that same depth
 * for exactly this reason. If the file is not there the check FAILS rather than
 * skips — a parity check that quietly stops finding the other package is the
 * purest can't-fail check there is.
 */
const CLIENT_SRC = join(import.meta.dirname, "..", "..", "src");
/**
 * THIS package's own source, for the three-way check on the spend record below.
 *
 * Same depth argument as `CLIENT_SRC`: `import.meta.dirname` is
 * `dashboard/server/<outDir>`, so the sources sit one directory up. Reading this
 * side as TEXT is only ever an ADDITION to a hardcoded expectation, never a
 * replacement for it — see the header on why two parsed sides can agree by
 * matching nothing.
 */
const SERVER_TYPES = join(import.meta.dirname, "..", "src", "api-types.ts");
/**
 * THE FOLD ITSELF, read as text for declaration site six.
 *
 * It is in THIS package and could have been imported — but `foldGraph`'s arms are
 * not observable from its signature, and calling it with one event of each type to
 * see whether the state changed proves nothing: several arms legitimately return
 * the same state (an event naming an unknown node is DROPPED by design). The
 * labels are the only thing that distinguishes "there is an arm" from "the default
 * swallowed it", so the labels are what is read.
 */
const SERVER_FOLD = join(import.meta.dirname, "..", "src", "graph.ts");
const CLIENT_LIB = join(CLIENT_SRC, "lib");
const CLIENT_TYPES = join(CLIENT_LIB, "api-types.ts");
const CLIENT_STREAM = join(CLIENT_LIB, "use-run-stream.ts");
/** Where the browser rebuilds the snapshot before folding the live tail onto it. */
const CLIENT_GRAPH_HOOK = join(CLIENT_LIB, "use-run-graph.ts");
const CLIENT_API = join(CLIENT_LIB, "api.ts");
/** The design-lock pair: the cards, and the page that hands their click a run id. */
const CLIENT_CARDS = join(CLIENT_SRC, "components", "run", "design-lock.tsx");
const CLIENT_RUN_PAGE = join(CLIENT_SRC, "app", "runs", "[runId]", "page.tsx");

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
 * RunDetail.designLock — one field, checked by name
 *
 * Everything above compares EVENT TYPES. A field added to the server's
 * `RunDetail` and forgotten in `dashboard/src/lib/api-types.ts` compiles clean
 * on BOTH sides, is serialised by the server, arrives at the browser, and simply
 * never renders — with no test, no typecheck and no lint saying anything. That
 * asymmetry was measured for this field (Task 11 Step 5 control 1): both
 * typechecks stay green and only these tests go red.
 *
 * THIS TEST AND THE `gateAttempts` ONE BELOW ARE PER-FIELD AND CLIENT-ONLY, and
 * that shape is exactly what let `references`/`documents` lag — see the
 * whole-shape check further down, which is the general form. They are kept
 * because they also pin the client's TYPE for each field, which the field-name
 * comparison cannot see.
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
    14,
    "the DesignLockState region did not parse as fourteen fields — re-point this parser, do not delete it",
  );
  for (const field of [
    /readonly awaiting: boolean;/,
    /readonly mockups: readonly Screenshot\[\];/,
    /readonly locked: string \| null;/,
    /readonly lockedBy: "owner" \| "ui-designer" \| "fallback" \| null;/,
    /readonly reason: string \| null;/,
    // THE NINE ADDED 2026-08-03. Their TYPES are pinned here and not only their
    // names, which is what the whole-shape check further down cannot see: a
    // client that declared `stage: string` would mirror the field and lose the
    // four states the panel branches on.
    /readonly directions: readonly DesignDirectionState\[\];/,
    /readonly chosenDirection: string \| null;/,
    /readonly chosenDirectionBy: "owner" \| "ui-designer" \| "fallback" \| null;/,
    /readonly stage: DesignStage;/,
    /readonly turnsUsed: number;/,
    /readonly turnsMax: number;/,
    /readonly rendersUsed: number;/,
    /readonly rendersMax: number;/,
    /readonly requests: readonly DesignRenderRequest\[\];/,
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

/* -------------------------------------------------------------------------
 * RunDetail's GATE/FIX loop outcome — Phase 2d Task 7, wired in Phase 2d
 * follow-up
 *
 * The same hole `designLock` above sits in, for the same reason: two fields
 * added to the server's `RunDetail` and forgotten in
 * `dashboard/src/lib/api-types.ts` compile clean on BOTH sides, are serialised,
 * arrive at the browser and never render. Nothing but this file compares the two
 * declarations, so a PARTIAL widening — server only, or one field of the two —
 * is what this exists to turn red.
 *
 * BOTH FIELDS ARE NAMED, NOT JUST ONE. They are a pair whose whole meaning is
 * joint: `gateAttempts: 0` with `gateStopReason: null` says "no outcome", and
 * either half alone is a sentence about nothing. A check on one could stay green
 * while the client mirrored the other, which is precisely the drift that ships.
 * ---------------------------------------------------------------------- */

test("CONTRACT: the client's RunDetail declares the gate/fix loop outcome, with the server's shape", () => {
  const detail = region(
    readClient(CLIENT_TYPES),
    CLIENT_TYPES,
    "export interface RunDetail extends RunSummary {",
    "\nexport ",
  );
  assert.match(
    detail,
    /readonly gateAttempts: number;/,
    "the client's RunDetail mirror has no gateAttempts: the server sends it and the UI cannot see it",
  );
  // `string | null` on BOTH sides, deliberately: the reason vocabulary lives in
  // `StopReason` (gate-fix-loop.ts) and neither api-types.ts imports it, so a
  // client that narrowed this to a literal union would compile, then silently
  // exclude a reason a newer server sends.
  assert.match(
    detail,
    /readonly gateStopReason: string \| null;/,
    "the client's RunDetail mirror has no gateStopReason, or narrowed it away from `string | null`",
  );
});

/* -------------------------------------------------------------------------
 * The lock policy the client asks for, AND the UI that can answer it
 *
 * THIS CHECK WAS `designLock: "auto"` AND THE CONDITION IT GUARDED WAS ALWAYS A
 * JOINT ONE: auto BECAUSE no card UI existed. `interactive` is true for a
 * dashboard-submitted run, so a policy of "ask" with nothing on screen able to
 * choose meant every web-UI ticket parked for the full timeout and then
 * fallback-locked the first mockup — two individually-correct decisions joined
 * into a 30-minute stall. The cards shipped, so the safe value flipped.
 *
 * SO IT IS STILL TWO HALVES, and collapsing it to `/designLock: "ask"/` would be
 * the same mistake in the other direction: a literal check that cannot see the
 * failure it was created for. The cards being deleted, refactored out or
 * disconnected from `resumeRun` while `"ask"` stays behind puts the run right
 * back where it was — parked, with nothing able to unpark it — and a one-sided
 * check would be green through all of it. BOTH halves are asserted here, so
 * removing either end turns this red.
 *
 * WHAT IT CANNOT SEE, because it is text across a package boundary: whether a
 * click actually reaches the server carrying the choice. That is
 * `dashboard/tests/design-lock.browser.spec.ts`, which drives a real browser
 * against a real `POST /api/runs/:id/resume` and reads the body off the wire.
 * This test proves the two ends EXIST and name each other; that suite proves
 * they work.
 * ---------------------------------------------------------------------- */

test("CONTRACT: the client asks for the lock policy its cards can answer", () => {
  // Comments are stripped first, here and in every region below: the
  // explanation ABOVE that line in api.ts must not be what satisfies this check.
  const create = region(
    readClient(CLIENT_API),
    CLIENT_API,
    "export function createRun(",
    "\nexport ",
  );

  // HALF ONE: the policy. Scoped to `createRun`'s own body rather than the whole
  // file, so this reads the object that is actually POSTed — and so a legitimate
  // "auto" somewhere else in api.ts later cannot trip the refusal below.
  assert.match(
    create,
    /designLock: "ask"/,
    "createRun no longer asks for a design lock: the mockup cards would never be reached, " +
      "because a dashboard submission that does not ask cannot park",
  );
  // A LEFT-BEHIND OR RE-ADDED "auto" IS THE QUIET VERSION OF THAT. Both keys in
  // one literal is legal JavaScript and the last one wins, so `match` above
  // cannot see it.
  assert.doesNotMatch(
    create,
    /designLock: "auto"/,
    "createRun states BOTH lock policies; whichever key is written last is the one on the wire",
  );

  // HALF TWO: the UI that answers the park. `readClient` throws when the file is
  // absent, so deleting the card component fails here rather than reporting
  // agreement between two things that no longer exist.
  const cards = withoutComments(readClient(CLIENT_CARDS));
  assert.match(
    cards,
    /onClick=\{\(\) => onChoose\(shot\.path\)\}/,
    "no card emits a choice any more: the panel renders five mockups and cannot answer the park",
  );

  const page = withoutComments(readClient(CLIENT_RUN_PAGE));
  assert.match(
    page,
    /onChoose=\{onChooseMockup\}/,
    "the run page renders no design-lock panel wired to a choice handler",
  );
  // THE CHOICE MUST TRAVEL. `resumeRun(runId)` with no second argument is a
  // different request: it hands the pick to `ui-designer` and records it as
  // automatic, which is the timeout's behaviour, not a click's.
  assert.match(
    page,
    /resumeRun\(runId, chosenMockup\)/,
    "a card click resumes without carrying the chosen mockup, putting ui-designer's name on the owner's decision",
  );
});

/* -------------------------------------------------------------------------
 * The seat-attributed spend record — five shapes, two packages
 *
 * WHY IT IS HERE AND NOT ONLY IN A TYPE. `ApiRunSpend` and its four companions
 * are hand-mirrored in `dashboard/src/lib/api-types.ts` as `RunSpend`,
 * `SeatSpend`, `VendorSpend`, `MeteredSpend` and `SpendSeat`. The two packages are
 * separate TypeScript programs with no path between them, so a field added on the
 * server and forgotten on the client compiles clean on BOTH sides — measured for
 * `designLock` and for the gate/fix pair above, and there is no reason this record
 * would be luckier.
 *
 * THREE LEGS, AND EACH ONE CLOSES A HOLE THE OTHER TWO LEAVE OPEN.
 *   · The seat UNION is compared against `SPEND_SEATS`, IMPORTED as a value and
 *     proven complete against `ApiSpendSeat` by an `Exclude` guard beside it. No
 *     regex can fake that side.
 *   · The four INTERFACES are compared field-name-set against a HARDCODED list
 *     here. Deleting a field from both packages fails this leg — which is exactly
 *     what a both-sides-textual comparison cannot see.
 *   · The same field sets are then compared SERVER TEXT against CLIENT TEXT, so a
 *     field added to the server and to this test but forgotten on the client is
 *     red, and so is the reverse.
 *
 * WHAT IT STILL CANNOT SEE: types. The two packages spell the same types
 * differently on purpose (`ApiTokens`/`TokenCounts`, `ApiProvider`/`Provider`), so
 * the per-field type assertions are hand-written client-side regexes below and
 * there is no mechanical comparison available.
 * ---------------------------------------------------------------------- */

function readSource(file: string, what: string): string {
  assert.ok(
    existsSync(file),
    `this check reads ${what} and it is not at ${file}. The file moved, or this test is ` +
      `running from an outDir that is not directly under dashboard/server.`,
  );
  return readFileSync(file, "utf8");
}

/**
 * The `readonly` field names of one interface, in declaration order.
 *
 * COMMENTS ARE STRIPPED BEFORE THE CLOSING BRACE IS FOUND, and that ordering is
 * not cosmetic — it is why this does not use `region` above. `region` slices the
 * RAW text and only then strips comments, so a docblock containing `{@link Foo}`
 * closes the region on the brace inside the comment. MEASURED, not theorised: the
 * first version of this check read `seat, provider` out of `ApiSeatSpend`'s five
 * fields, because `modelId`'s docblock mentions `{@link ModelTokens}`, and went
 * red naming the wrong cause — "the server and the client have drifted" for two
 * files that agreed exactly.
 *
 * A PARSE OF ZERO FIELDS THROWS. An interface that yielded no names would make
 * every comparison below trivially agree with any other empty parse, which is the
 * can't-fail shape this whole file exists to avoid.
 */
function fieldNames(source: string, file: string, open: string): readonly string[] {
  const stripped = withoutComments(source);
  const start = stripped.indexOf(open);
  assert.notEqual(
    start,
    -1,
    `${file}: the anchor \`${open}\` is gone. This check parses that declaration; re-point it at ` +
      `whatever replaced it rather than deleting the check.`,
  );
  const from = start + open.length;
  const end = stripped.indexOf("}", from);
  assert.notEqual(end, -1, `${file}: \`${open}\` has no closing brace.`);
  const names = literals(stripped.slice(from, end), /readonly\s+([A-Za-z][A-Za-z0-9]*)\s*[?:]/g);
  assert.notEqual(
    names.length,
    0,
    `${file}: \`${open}\` parsed as ZERO fields — re-point this parser, do not delete it.`,
  );
  return names;
}

/** Server interface -> client interface, and the fields both must declare. */
const SPEND_SHAPES: readonly {
  readonly server: string;
  readonly client: string;
  readonly fields: readonly string[];
}[] = [
  {
    server: "ApiSeatSpend",
    client: "SeatSpend",
    fields: ["seat", "provider", "modelId", "tokens", "callCount"],
  },
  {
    server: "ApiVendorSpend",
    client: "VendorSpend",
    fields: ["provider", "tokens", "callCount", "seats"],
  },
  {
    server: "ApiMeteredSpend",
    client: "MeteredSpend",
    fields: ["kind", "model", "calls", "deliveredSecondsFloor"],
  },
  {
    server: "ApiRunSpend",
    client: "RunSpend",
    fields: ["bySeat", "byVendor", "metered", "pricing"],
  },
];

test("CONTRACT: the client's SpendSeat union names exactly the server's seats", () => {
  // THE ATTRIBUTION IS THE FEATURE, so a missing member is not a cosmetic gap: a
  // client that has never heard of `fix` renders a run's fix-round spend nowhere,
  // and a client that has never heard of `audit` merges 17,603 tokens into
  // whichever seat its renderer defaults to.
  const union = region(
    readClient(CLIENT_TYPES),
    CLIENT_TYPES,
    "export type SpendSeat =",
    ";",
  );
  const found = literals(union, /"([a-z_]+)"/g);
  assert.deepEqual(
    sorted(found),
    sorted([...SPEND_SEATS]),
    `spend-seat drift: the server accumulates ${SPEND_SEATS.join(", ")} and the client's SpendSeat ` +
      `names ${found.join(", ")}. The server's union is api-types.ts::ApiSpendSeat, proven complete ` +
      "against SPEND_SEATS by the Exclude guard beside it; the client mirrors it by hand.",
  );
});

test("CONTRACT: the client mirrors every field of the spend record, in both directions", () => {
  const client = readClient(CLIENT_TYPES);
  const server = readSource(SERVER_TYPES, "this package's own api-types.ts");

  for (const shape of SPEND_SHAPES) {
    const onServer = fieldNames(server, SERVER_TYPES, `export interface ${shape.server} {`);
    const onClient = fieldNames(client, CLIENT_TYPES, `export interface ${shape.client} {`);

    // LEG ONE: the hardcoded expectation. Deleting a field from BOTH packages is
    // red here and is invisible to the comparison below.
    assert.deepEqual(
      sorted(onClient),
      sorted(shape.fields),
      `${shape.client} in the client does not declare ${shape.fields.join(", ")} — it declares ` +
        `${onClient.join(", ")}. The server sends the full shape and the UI cannot see what it omits.`,
    );
    // LEG TWO: the two packages against each other. A field added to the server
    // and to the list above, with the client untouched, is red here.
    assert.deepEqual(
      sorted(onServer),
      sorted(onClient),
      `${shape.server} and ${shape.client} have drifted: the server declares ${onServer.join(", ")} ` +
        `and the client ${onClient.join(", ")}. Nothing but this test compares them.`,
    );
  }
});

test("CONTRACT: the client's spend fields carry the server's types, and pricing is the literal", () => {
  const client = readClient(CLIENT_TYPES);

  const seat = region(client, CLIENT_TYPES, "export interface SeatSpend {", "}");
  for (const field of [
    /readonly seat: SpendSeat;/,
    /readonly provider: Provider;/,
    /readonly modelId: string;/,
    /readonly tokens: TokenCounts;/,
    /readonly callCount: number;/,
  ]) {
    assert.match(seat, field, `the client's SeatSpend is missing ${String(field)}`);
  }

  const vendor = region(client, CLIENT_TYPES, "export interface VendorSpend {", "}");
  assert.match(
    vendor,
    /readonly seats: readonly SpendSeat\[\];/,
    "the client's VendorSpend does not name the seats folded into a vendor total, so a reader " +
      "cannot see that the builder is one seat of four",
  );

  const metered = region(client, CLIENT_TYPES, "export interface MeteredSpend {", "}");
  assert.match(
    metered,
    /readonly kind: "image" \| "video";/,
    "the client's MeteredSpend narrowed or widened the kind away from the server's two",
  );
  // `number | null`, and the NULL is the field's meaning: an image call is not
  // billed by time. A client that typed this `number` would render "0s of video"
  // for every image-only run.
  assert.match(
    metered,
    /readonly deliveredSecondsFloor: number \| null;/,
    "the client's MeteredSpend lost the nullable floor, or narrowed it to a number",
  );

  const run = region(client, CLIENT_TYPES, "export interface RunSpend {", "}");
  assert.match(run, /readonly bySeat: readonly SeatSpend\[\];/);
  assert.match(run, /readonly byVendor: readonly VendorSpend\[\];/);
  assert.match(run, /readonly metered: readonly MeteredSpend\[\];/);
  // THE FIELD THAT STOPS A RUN READING AS FREE. `pricing: string` would compile,
  // mirror, render — and let a UI print an em dash beside a run that spent half a
  // million tokens, which is the failure the field was added to prevent.
  assert.match(
    run,
    /readonly pricing: PricingBasis;/,
    "the client's RunSpend does not carry the pricing basis as PricingBasis",
  );
  const basis = region(client, CLIENT_TYPES, "export type PricingBasis =", ";");
  assert.match(
    basis,
    /"not-priced-subscription-seat"/,
    "the client's PricingBasis is not the server's literal: `costUsd: null` and `totalCostUsd: 0` " +
      "are both already read as free, and this literal is the only thing that says otherwise",
  );
});

/* -------------------------------------------------------------------------
 * `RunDetail` AND ITS NESTED SHAPES — the whole record, not selected fields
 *
 * WHY THIS EXISTS, AND WHAT IT COST TO LEARN. Until this check, the only things
 * comparing `RunDetail` across the packages were the two per-field tests above:
 * one names `designLock`, one names `gateAttempts`/`gateStopReason`. A field the
 * server grew that NEITHER test names was invisible — and that is not
 * hypothetical. `references` and `documents` were added to the server's
 * `RunDetail` with `ApiAttachment` on 2026-08-02, the client mirror was
 * deliberately left untouched to avoid a concurrent-edit collision, and the
 * whole suite stayed green: 1165/1163 at the time. Both typechecks passed, the
 * server serialised both fields, the browser received them, and no renderer
 * could see them. `docs/STATE-2026-08-02-end-to-end.md` records the gap and
 * points at this file's own header for admitting it.
 *
 * SO THE UNIT OF COMPARISON IS THE WHOLE FIELD SET, in both directions. Adding a
 * field to either side alone is red here without anyone remembering to write a
 * test for that particular field, which is the property the per-field tests
 * structurally cannot have.
 *
 * THREE LEGS, COPIED FROM THE SPEND RECORD ABOVE because that shape is the one
 * with teeth:
 *   · LEG ONE compares the client against a HARDCODED list here. Deleting a
 *     field from BOTH packages is red — the failure a two-sided textual
 *     comparison cannot see, because two empty parses agree.
 *   · LEG TWO compares SERVER TEXT against CLIENT TEXT. A field added to the
 *     server and to the list here but forgotten on the client is red, and so is
 *     the reverse.
 *   · The parser itself throws on a zero-field parse (`fieldNames`), so a
 *     refactor that moves a declaration reads as a refactor rather than as
 *     agreement between two things that were never found.
 *
 * WHAT IT COVERS: twelve shapes, named in `DETAIL_SHAPES`. `RunDetail` itself,
 * the `RunSummary` it extends, and the ten nested INTERFACES its fields are
 * typed with.
 *
 * WHAT IT DOES NOT COVER, NAMED RATHER THAN IMPLIED:
 *   · THE TWO UNIONS. `ApiPublishedProject`/`PublishedProject` and the server's
 *     `ApiProjectProcess` are discriminated unions of object literals, and
 *     `fieldNames` closes on the FIRST `}` — it would silently read one member
 *     and compare a fragment. They are excluded deliberately rather than
 *     half-checked; `ProjectExclusion`, which `PublishedProject` carries, IS in
 *     the list below.
 *   · TYPES. This compares field NAMES. A client `references` typed
 *     `readonly string[]` passes here. The per-field regex tests above are where
 *     a type is pinned, and `Attachment`'s six are pinned in the test after this
 *     one for exactly that reason.
 *   · WHETHER ANYTHING RENDERS THE FIELD. A mirrored type nothing reads is still
 *     invisible to the owner; that is a component test's job, not this file's.
 *
 * THREE NEGATIVE CONTROLS, APPLIED, WATCHED AND RESTORED (both files verified
 * byte-identical by sha1 afterwards). They are three rather than one because the
 * checks below are complementary and a single mutation would not have shown it:
 *
 *   1. `documents` DELETED FROM THE CLIENT ONLY — the exact 2026-08-02 lag.
 *      Both the whole-shape test and the attachment-field test went red; the
 *      first named it as "the client does not declare … it declares …" with
 *      `documents` absent from the second list. This is the mutation the file
 *      previously could not see at all.
 *   2. CLIENT `references` RETYPED `readonly string[]`, THE NAME LEFT ALONE.
 *      The whole-shape test stayed GREEN and only the typed test went red —
 *      which is the discrimination that justifies keeping both, and the reason
 *      the whole-shape check is documented above as not covering types.
 *   3. `mediaType` DELETED FROM **BOTH** PACKAGES. Leg two (server text vs
 *      client text) agreed perfectly, exactly as a two-sided textual comparison
 *      must; leg one's hardcoded list is what went red. This is the can't-fail
 *      shape this whole file exists to avoid, and it is why the field lists
 *      below are spelled out rather than derived.
 * ---------------------------------------------------------------------- */

/** Server interface -> client interface, and the fields both must declare. */
const DETAIL_SHAPES: readonly {
  readonly server: string;
  readonly client: string;
  readonly fields: readonly string[];
}[] = [
  {
    server: "RunSummary",
    client: "RunSummary",
    fields: [
      "runId",
      "ticketTitle",
      "modelId",
      "status",
      "startedAt",
      "endedAt",
      "heldOutPass",
      "falseFinish",
    ],
  },
  {
    // The anchor is spelled identically on both sides, `extends` included, so a
    // side that stopped extending the summary fails on the anchor rather than
    // by quietly comparing a different declaration.
    server: "RunDetail extends RunSummary",
    client: "RunDetail extends RunSummary",
    fields: [
      "ticketText",
      "phase",
      "criteria",
      "machineChecks",
      "tokens",
      "costUsd",
      "rateLimit",
      "silence",
      "screenshots",
      "references",
      "documents",
      "artifactPath",
      "previewUrl",
      "publishedProject",
      "inferredCriteria",
      "verdictPath",
      "gateAttempts",
      "gateStopReason",
      "failureReason",
      "designLock",
      "adversary",
      "motion",
    ],
  },
  {
    // THE SHAPE THE LAG WAS IN. `references`/`documents` are lists of this.
    server: "ApiAttachment",
    client: "Attachment",
    fields: ["file", "path", "sha256", "bytes", "mediaType", "url"],
  },
  {
    server: "ApiScreenshot",
    client: "Screenshot",
    fields: ["path", "label", "capturedAt"],
  },
  {
    server: "ApiCriterion",
    client: "RunCriterion",
    fields: ["id", "statement", "tier", "result"],
  },
  {
    // THE OTHER HALF OF THE GRADE, and the one that had no client declaration at
    // all until 2026-08-18. `label` is the field this row is really guarding: it
    // is composed SERVER-side precisely so that one gate has one sentence, and a
    // client mirror that dropped it would push twelve renderers into inventing
    // their own — which is the drift `contract-parity` exists to catch one layer
    // up from where it usually happens.
    server: "ApiMachineCheck",
    client: "MachineCheck",
    fields: ["id", "label", "passed", "detail"],
  },
  {
    server: "ApiTokens",
    client: "TokenCounts",
    fields: ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"],
  },
  {
    server: "ApiRateLimit",
    client: "RateLimitState",
    fields: ["limited", "retryAfterSec"],
  },
  {
    server: "ApiRunSilence",
    client: "RunSilence",
    fields: ["since", "sinceKind", "quietMin", "thresholdMin", "overThreshold"],
  },
  {
    server: "ApiDesignLock",
    client: "DesignLockState",
    // FOURTEEN SINCE 2026-08-03. The nine added fields carry the two-stage
    // canvass, and every one of them is a field the panel cannot render if the
    // client omits it — `stage` most of all: without it the panel reports
    // "unlocked" for the whole five-to-seven-generation stage-B window.
    fields: [
      "awaiting",
      "mockups",
      "locked",
      "lockedBy",
      "reason",
      "directions",
      "chosenDirection",
      "chosenDirectionBy",
      "stage",
      "turnsUsed",
      "turnsMax",
      "rendersUsed",
      "rendersMax",
      "requests",
    ],
  },
  {
    server: "ApiDesignDirection",
    client: "DesignDirectionState",
    fields: ["slug", "name", "distinction", "discarded", "mockups", "notes"],
  },
  {
    server: "ApiDesignRenderRequest",
    client: "DesignRenderRequest",
    fields: ["at", "section", "direction", "outcome", "detail", "mockup"],
  },
  {
    server: "ApiAdversaryPass",
    client: "AdversaryPass",
    fields: ["ran", "stop", "stopDetail", "findings"],
  },
  {
    server: "ApiAdversaryFinding",
    client: "AdversaryFinding",
    fields: ["severity", "klass", "summary", "detail"],
  },
  {
    // Carried by the `published: true` member of `PublishedProject`, which is
    // itself a union this check cannot parse. The leaf still can be.
    server: "ApiProjectExclusion",
    client: "ProjectExclusion",
    fields: ["path", "reason"],
  },
  {
    // THE SHAPE ADDED BEFORE ANYTHING SENDS IT, which is the opposite order from
    // `references`/`documents` and is the whole point: that pair reached the wire
    // first and the mirror months later, and nothing here noticed. `motion` is
    // declared on both sides in one commit, so the day a producer starts filling
    // it there is a client that already knows the name of every field.
    //
    // THE NAME IS `ApiMotionSpec` ON BOTH SIDES, unlike every other row above.
    // The client drops the `Api` prefix by convention; here it does not, because
    // the wire shape has a same-named domain twin (`MotionSpec` in
    // motion-types.ts, which carries the un-quantised reading) and a client type
    // called `MotionSpec` would invite a reader to assume they are the same
    // declaration. They are not: this one is what a JSON response can carry.
    server: "ApiMotionSpec",
    client: "ApiMotionSpec",
    fields: ["url", "capturedAt", "entries", "libraries", "respectsReducedMotion"],
  },
  {
    server: "ApiMotionEntry",
    client: "ApiMotionEntry",
    fields: [
      "family",
      "role",
      "props",
      "durationMs",
      "staggerMs",
      "easing",
      "iterations",
      "scrollRatio",
      "parity",
    ],
  },
];

test("CONTRACT: the client mirrors every field of RunDetail and its nested shapes, in both directions", () => {
  const client = readClient(CLIENT_TYPES);
  const server = readSource(SERVER_TYPES, "this package's own api-types.ts");

  for (const shape of DETAIL_SHAPES) {
    const onServer = fieldNames(server, SERVER_TYPES, `export interface ${shape.server} {`);
    const onClient = fieldNames(client, CLIENT_TYPES, `export interface ${shape.client} {`);

    // LEG ONE: the hardcoded expectation. Deleting a field from BOTH packages is
    // red here and is invisible to the comparison below.
    assert.deepEqual(
      sorted(onClient),
      sorted(shape.fields),
      `${shape.client} in the client does not declare ${shape.fields.join(", ")} — it declares ` +
        `${onClient.join(", ")}. The server sends the full shape and the UI cannot see what it omits.`,
    );
    // LEG TWO: the two packages against each other.
    assert.deepEqual(
      sorted(onServer),
      sorted(onClient),
      `${shape.server} and ${shape.client} have drifted: the server declares ${onServer.join(", ")} ` +
        `and the client ${onClient.join(", ")}. Nothing but this test compares them, and a field the ` +
        "server sends that the client never declares is serialised, delivered and never rendered.",
    );
  }
});

test("CONTRACT: the client's attachment fields carry the server's types, and the URL is the browser's only handle", () => {
  /*
   * THE COMPANION TO THE FIELD-NAME CHECK, for the one shape whose types decide
   * whether anything renders. A client `Attachment` whose `url` were typed
   * `string | null` or whose `bytes` were `string` would mirror every NAME and
   * still break the panel, and the check above cannot see it.
   *
   * `url` AND `path` ARE BOTH `string` AND ARE NOT INTERCHANGEABLE — `path` is an
   * absolute HOST path a browser cannot open, `url` is same-origin and
   * route-relative. Nothing in a type can enforce which one a renderer reaches
   * for; both are pinned here so neither can quietly go missing.
   */
  const attachment = region(readClient(CLIENT_TYPES), CLIENT_TYPES, "export interface Attachment {", "}");
  for (const field of [
    /readonly file: string;/,
    /readonly path: string;/,
    /readonly sha256: string;/,
    /readonly bytes: number;/,
    /readonly mediaType: string;/,
    /readonly url: string;/,
  ]) {
    assert.match(attachment, field, `the client's Attachment is missing ${String(field)}`);
  }
});

test("CONTRACT: the client's RunDetail declares the ticket's attachments, as lists of Attachment", () => {
  /*
   * THE REGRESSION THIS FILE FAILED TO CATCH ONCE, PINNED BY NAME AND BY TYPE.
   * The field-name check above would go red if either field were dropped, but it
   * would stay green if `references` were typed `readonly string[]` — which is
   * the plausible wrong mirror, because the POST that creates them takes
   * `readonly string[]` (base64 data URLs) and the two live a few hundred lines
   * apart in the same file.
   *
   * BOTH FIELDS, NOT ONE. They are a pair for the same reason `gateAttempts` and
   * `gateStopReason` are: the server folds them off the SAME manifest in the
   * same request, so a mirror that gained one and not the other is the partial
   * widening that actually happens.
   */
  const detail = region(
    readClient(CLIENT_TYPES),
    CLIENT_TYPES,
    "export interface RunDetail extends RunSummary {",
    "\nexport ",
  );
  assert.match(
    detail,
    /readonly references: readonly Attachment\[\];/,
    "the client's RunDetail mirror has no `references: readonly Attachment[]`: the owner's own " +
      "reference images are serialised by the server and no panel can see them",
  );
  assert.match(
    detail,
    /readonly documents: readonly Attachment\[\];/,
    "the client's RunDetail mirror has no `documents: readonly Attachment[]`: the owner's attached " +
      "scope or CV is serialised by the server and no panel can see it",
  );
});

test("CONTRACT: the client's RunDetail declares the machine checks, nullable, as a list of MachineCheck", () => {
  /*
   * THE COMPANION TO THE FIELD-NAME CHECK, for the one distinction this field
   * carries all of its meaning in. The whole-shape test above goes red if
   * `machineChecks` is missing from either side — and it stays GREEN on a client
   * that mirrored the name and typed it `readonly MachineCheck[]`, dropping the
   * `| null`.
   *
   * WHY THAT NARROWING WOULD MATTER MORE THAN MOST. `null` is "this run never
   * reached the gate" and `[]` is a state the server cannot produce: a gate that
   * runs produces all twelve results. A client that cannot type the null has no
   * way to render the difference, and the panel then draws a queued run exactly
   * like a gated one — the conflation `heldOutPass: null` and `gateAttempts: 0`
   * exist to refuse, arriving through the type instead of through the data.
   */
  const detail = region(
    readClient(CLIENT_TYPES),
    CLIENT_TYPES,
    "export interface RunDetail extends RunSummary {",
    "\nexport ",
  );
  assert.match(
    detail,
    /readonly machineChecks: readonly MachineCheck\[\] \| null;/,
    "the client's RunDetail mirror has no `machineChecks: readonly MachineCheck[] | null`: either the " +
      "twelve machine gates are serialised and no panel can see them, or the client narrowed away the " +
      "null that distinguishes a run that was never gated from one that was",
  );
});

test("CONTRACT: the client's motion shape parses as nine fields and carries the server's types", () => {
  /*
   * THE COUNT IS FIRST, AND IT IS THE REASON THIS TEST EXISTS AT ALL.
   *
   * `fieldNames` — the parser the whole-shape check above runs — closes on the
   * FIRST `}` after its anchor. A member that ever spans braces (an inlined
   * object literal for `props`, a nested `{ from, to }`) truncates it, and both
   * legs of that check would then compare a FRAGMENT against a fragment: leg two
   * compares two truncations that agree, and leg one's message would name the
   * wrong cause ("the client does not declare durationMs …") for two files that
   * agree exactly. That is not theoretical — `fieldNames`' own docblock records
   * it happening to `ApiSeatSpend`, where a `{@link ModelTokens}` inside a
   * docblock made a five-field interface parse as two.
   *
   * SO THE SHAPE IS COUNTED BEFORE ITS FIELDS ARE READ, the same order and the
   * same argument as the `DesignLockState` check near the top of this file. Nine
   * is the number of things a motion entry says; a parse that yields any other
   * number is a broken parser rather than a drifted mirror, and this assertion
   * makes the truncation say so itself instead of letting the checks above pass
   * while covering nothing.
   *
   * NOTE THE PARSER DIFFERENCE, because it widens what this catches. `region`
   * slices RAW text and strips comments afterwards, so it closes on a brace
   * inside a docblock too — stricter than `fieldNames`, which strips first. Both
   * are hazards for this file; only one of them can reach `fieldNames`.
   *
   * AND THEN THE TYPES, which no field-name comparison can see. A client
   * `staggerMs: number` would mirror the NAME and lose the distinction the field
   * exists for — `null` is "this role had no siblings", `0` would be "the
   * siblings moved together" — and a `props: string` would mirror the name and
   * render a list as a character sequence.
   */
  const client = readClient(CLIENT_TYPES);

  const entry = region(client, CLIENT_TYPES, "export interface ApiMotionEntry {", "}");
  assert.equal(
    entry.split(";").length - 1,
    9,
    "the ApiMotionEntry region did not parse as nine fields — re-point this parser, do not delete it",
  );
  for (const field of [
    // `string`, NOT the twelve-member union, and pinned as `string` on purpose:
    // a client that spelled the union out would silently drop a thirteenth
    // family a newer server sends, which is `gateStopReason`'s argument.
    /readonly family: string;/,
    /readonly role: string;/,
    /readonly props: readonly string\[\];/,
    /readonly durationMs: number;/,
    /readonly staggerMs: number \| null;/,
    /readonly easing: string \| null;/,
    /readonly iterations: number \| null;/,
    /readonly scrollRatio: number \| null;/,
    /readonly parity: boolean;/,
  ]) {
    assert.match(entry, field, `the client's ApiMotionEntry is missing ${String(field)}`);
  }

  const spec = region(client, CLIENT_TYPES, "export interface ApiMotionSpec {", "}");
  assert.equal(
    spec.split(";").length - 1,
    5,
    "the ApiMotionSpec region did not parse as five fields — re-point this parser, do not delete it",
  );
  assert.match(
    spec,
    /readonly entries: readonly ApiMotionEntry\[\];/,
    "the client's ApiMotionSpec does not carry its entries as a list of ApiMotionEntry, so the one " +
      "field with any content in it is unreadable",
  );

  // AND THE FIELD ON `RunDetail` ITSELF, BY TYPE. The whole-shape check above
  // proves the NAME is on both sides; a client that typed it `unknown` or
  // widened it to `object` would pass that and still render nothing.
  const detail = region(client, CLIENT_TYPES, "export interface RunDetail extends RunSummary {", "\nexport ");
  assert.match(
    detail,
    /readonly motion: ApiMotionSpec \| null;/,
    "the client's RunDetail mirror has no `motion: ApiMotionSpec | null`",
  );
});

/* -------------------------------------------------------------------------
 * DECLARATION SITE SIX — every event type the fold claims to handle has an arm
 *
 * THE ONE THAT NOTHING WATCHED. Adding an `SseEvent` member is enforced at five
 * places by now: `tsc` refuses the union without `SSE_EVENT_TYPES`, and the three
 * checks at the top of this file refuse a client that has not mirrored it. Not one
 * of them looks at `foldGraph`. Its `default:` returns the state unchanged — which
 * is CORRECT and load-bearing, since a run recorded by an older build is a stream
 * of types this version has never heard of — and the same branch silently swallows
 * an event type this version DOES know and simply forgot to fold. The event
 * arrives, parses, folds to nothing, and the canvas renders exactly as if the
 * emitter had never run. That is the failure the whole observability lane exists
 * to stop shipping, reached from the one side with no check on it.
 *
 * IT IS A PARTITION, NOT A COMPLETENESS CHECK, AND THAT DISTINCTION IS THE WHOLE
 * DESIGN. "Every member of the union has an arm" is FALSE by design — `tool`,
 * `criterion`, `screenshot`, `tokens`, `rate_limit` and `verdict` deliberately fold
 * to nothing, because none of them says anything about the canvas. So the two
 * lists below must together name the union EXACTLY: a new event type is a
 * compile-clean, test-green nothing until somebody puts it in one list or the
 * other, and putting it in the folded list without writing the arm is red.
 *
 * BOTH DIRECTIONS ARE CHECKED. An arm that appears for a type on the unfolded list
 * is red too — not because writing it is wrong, but because the list is then a
 * lie, and the next reader trusts the list.
 * ---------------------------------------------------------------------- */

/** Event types `foldGraph` must have a `case` for. */
const FOLDED_EVENT_TYPES: readonly string[] = [
  // The canvas's own events.
  "graph_agent",
  "graph_agent_status",
  "graph_tool",
  "graph_skill",
  "graph_hook",
  "graph_result",
  "graph_inventory",
  "graph_narration",
  "graph_diff",
  // A terminal status resolves a still-running node, and a still-running stage.
  "status",
  // The pre-build lane is projected from the rows the server has always written.
  "phase",
  "log",
];

/**
 * Event types that fold to nothing ON PURPOSE, each for a stated reason.
 *
 *   · `tool` — the BUILD sink's flat tool line. The canvas's copy is `graph_tool`,
 *     which carries a node; this one carries no attribution at all.
 *   · `criterion`, `verdict` — the gate's record. It lands in `RunDetail`, which
 *     the run sheet reads; nothing on the canvas is keyed on a criterion.
 *   · `screenshot` — `RunDetail.screenshots` is the authoritative list and the
 *     canvas's preview is derived from the run, not from the stream.
 *   · `tokens`, `rate_limit` — counters and provider state. Neither names a node.
 */
const UNFOLDED_EVENT_TYPES: readonly string[] = [
  "tool",
  "criterion",
  "screenshot",
  "tokens",
  "rate_limit",
  "verdict",
];

/** The `case "x":` labels inside `foldGraph`, comments stripped. */
function foldArms(): readonly string[] {
  const fold = region(
    readSource(SERVER_FOLD, "this package's own graph.ts"),
    SERVER_FOLD,
    "export function foldGraph(",
    "\nexport ",
  );
  const found = literals(fold, /\bcase\s+"([a-z_]+)"\s*:/g);
  assert.notEqual(
    found.length,
    0,
    `${SERVER_FOLD}: foldGraph parsed as ZERO case labels — re-point this parser, do not delete it.`,
  );
  return found;
}

test("CONTRACT: every server event type is classified as folded or deliberately not", () => {
  assert.deepEqual(
    sorted([...FOLDED_EVENT_TYPES, ...UNFOLDED_EVENT_TYPES]),
    sorted(SERVER),
    "an SseEvent member is in neither list. Decide which it is: give it a `case` in " +
      "graph.ts and add it to FOLDED_EVENT_TYPES, or add it to UNFOLDED_EVENT_TYPES with " +
      "the reason it says nothing about the canvas. Leaving it unclassified is how an event " +
      "type ships that the fold silently discards.",
  );
});

test("CONTRACT: foldGraph has an arm for every event type this program folds", () => {
  const arms = foldArms();
  for (const type of FOLDED_EVENT_TYPES) {
    assert.ok(
      arms.includes(type),
      `foldGraph has no \`case "${type}":\`. The event is delivered, parsed and dropped at ` +
        "`default: return state`, and the canvas renders exactly as if nothing had been " +
        "emitted — with tsc green in both packages and every other check in this file green.",
    );
  }
  for (const type of UNFOLDED_EVENT_TYPES) {
    assert.ok(
      !arms.includes(type),
      `foldGraph now folds "${type}", which UNFOLDED_EVENT_TYPES says it deliberately ignores. ` +
        "Move it to FOLDED_EVENT_TYPES — the lists are what the next reader trusts.",
    );
  }
});

/* -------------------------------------------------------------------------
 * DECLARATION SITE SEVEN — the folded canvas, field for field, in both packages
 *
 * THE SAME HOLE `references`/`documents` SAT IN, one layer over. `GraphState` and
 * everything hanging off it are hand-mirrored in `dashboard/src/lib/api-types.ts`,
 * the two packages cannot import each other, and a field added on one side alone
 * compiles clean on BOTH. The canvas is now the shape carrying the narration, the
 * diffs and the pre-build lane, so this is where the next silent drop would be.
 *
 * `GraphActivityEntry.kind` IS THE FIELD THIS WAS WRITTEN FOR. It grew from two
 * members to four. A client that mirrored the NAME and typed it `string` passes
 * every field-name comparison in this file and loses the branch the renderer
 * switches on, which is the same class of defect as a mirrored `stage: string` in
 * `DesignLockState`. The literal union is pinned below.
 *
 * THE THREE LEGS ARE THE SPEND RECORD'S, for the reasons its header gives:
 * hardcoded expectation, then server text against client text, and a parser that
 * throws rather than reporting agreement between two empty parses.
 * ---------------------------------------------------------------------- */

/** Server interface -> client interface, and the fields both must declare. */
const CANVAS_SHAPES: readonly {
  readonly server: string;
  readonly client: string;
  readonly fields: readonly string[];
}[] = [
  {
    // FOUR FIELDS, NOT THREE, SINCE 2026-08-04. `stages` is the pre-build lane,
    // and the reason it is optional — plus the five lines that make it required —
    // is written at its declaration in both packages.
    server: "GraphState",
    client: "GraphState",
    fields: ["nodes", "edges", "inventory", "stages"],
  },
  {
    server: "GraphNode",
    client: "GraphNode",
    fields: [
      "id",
      "parent",
      "agent",
      "lane",
      "description",
      "ambient",
      "state",
      "attribution",
      "sdk",
      "tools",
      "skills",
      "hooks",
      "toolCalls",
      "result",
      "activity",
      "activityDropped",
    ],
  },
  {
    // SIX SINCE THE DIFF LANDED. `diff` is present if and only if `kind` is
    // `"diff"`; a client that never declared it renders every edit as a bare
    // one-line summary with the green and red lines delivered and unread.
    server: "GraphActivityEntry",
    client: "GraphActivityEntry",
    fields: ["at", "kind", "name", "detail", "truncated", "diff"],
  },
  {
    server: "GraphDiff",
    client: "GraphDiff",
    fields: [
      "path",
      "change",
      "additions",
      "deletions",
      "hunks",
      "capped",
      "droppedHunks",
      "droppedLines",
    ],
  },
  {
    server: "GraphDiffHunk",
    client: "GraphDiffHunk",
    fields: ["oldStart", "oldLines", "newStart", "newLines", "lines"],
  },
  {
    server: "GraphStage",
    client: "GraphStage",
    fields: ["id", "label", "detail", "state", "at"],
  },
  { server: "GraphEdge", client: "GraphEdge", fields: ["from", "to", "attribution"] },
  {
    server: "GraphResult",
    client: "GraphResult",
    fields: ["state", "summary", "totalTokens", "toolUses", "durationMs"],
  },
  { server: "GraphToolPill", client: "GraphToolPill", fields: ["name", "mcpServer", "count"] },
  { server: "GraphSkillPill", client: "GraphSkillPill", fields: ["skill", "source", "count"] },
  {
    server: "GraphHookPill",
    client: "GraphHookPill",
    fields: ["event", "tool", "decision", "count"],
  },
  {
    server: "GraphInventory",
    client: "GraphInventory",
    fields: [
      "agents",
      "skills",
      "tools",
      "allowedAgents",
      "mcpServers",
      "plugins",
      "model",
      "claudeCodeVersion",
      "environmentHash",
    ],
  },
  { server: "GraphSdkRef", client: "GraphSdkRef", fields: ["taskId", "toolUseId"] },
  { server: "GraphMcpServer", client: "GraphMcpServer", fields: ["name", "status"] },
];

test("CONTRACT: the client mirrors every field of the folded canvas, in both directions", () => {
  const client = readClient(CLIENT_TYPES);
  const server = readSource(SERVER_TYPES, "this package's own api-types.ts");

  for (const shape of CANVAS_SHAPES) {
    const onServer = fieldNames(server, SERVER_TYPES, `export interface ${shape.server} {`);
    const onClient = fieldNames(client, CLIENT_TYPES, `export interface ${shape.client} {`);

    assert.deepEqual(
      sorted(onClient),
      sorted(shape.fields),
      `${shape.client} in the client does not declare ${shape.fields.join(", ")} — it declares ` +
        `${onClient.join(", ")}. The fold produces the full shape and the canvas cannot see what it omits.`,
    );
    assert.deepEqual(
      sorted(onServer),
      sorted(onClient),
      `${shape.server} and ${shape.client} have drifted: the server declares ${onServer.join(", ")} ` +
        `and the client ${onClient.join(", ")}. Nothing but this test compares them.`,
    );
  }
});

test("CONTRACT: the client's canvas fields carry the server's types, kind and stages most of all", () => {
  const client = readClient(CLIENT_TYPES);

  const entry = region(client, CLIENT_TYPES, "export interface GraphActivityEntry {", "}");
  assert.equal(
    entry.split(";").length - 1,
    6,
    "the GraphActivityEntry region did not parse as six fields — re-point this parser, do not delete it",
  );
  for (const field of [
    // THE FOUR MEMBERS, SPELLED OUT. Unlike `family` in the motion readout — which
    // is pinned as `string` so a newer server can send a thirteenth — this union is
    // exhaustively rendered: every member has a branch, and a member the client has
    // never heard of would be drawn by the fallback arm rather than dropped. The
    // renderer is the reason the literal is pinned here.
    /readonly kind: "tool" \| "skill" \| "narration" \| "diff";/,
    /readonly at: string \| null;/,
    /readonly name: string;/,
    /readonly truncated: boolean;/,
    // OPTIONAL, NOT `GraphDiff | null`. A client that typed it nullable would read
    // `entry.diff === null` on every tool row and be right; it would also declare a
    // key the server never sends, and `assert.deepEqual` against a folded state is
    // how this repository checks the canvas.
    /readonly diff\?: GraphDiff;/,
  ]) {
    assert.match(entry, field, `the client's GraphActivityEntry is missing ${String(field)}`);
  }

  const diff = region(client, CLIENT_TYPES, "export interface GraphDiff {", "}");
  for (const field of [
    /readonly path: string;/,
    /readonly change: "added" \| "modified";/,
    /readonly additions: number;/,
    /readonly deletions: number;/,
    /readonly hunks: readonly GraphDiffHunk\[\];/,
    // THE FLAG THAT STOPS A PARTIAL DIFF READING AS A WHOLE ONE. A client that
    // omitted or renamed it would render eighty lines of a three-thousand-line
    // write with nothing on screen saying so.
    /readonly capped: boolean;/,
  ]) {
    assert.match(diff, field, `the client's GraphDiff is missing ${String(field)}`);
  }
  assert.match(
    region(client, CLIENT_TYPES, "export interface GraphDiffHunk {", "}"),
    /readonly lines: readonly string\[\];/,
    "the client's GraphDiffHunk does not carry its lines as strings, so the one field with the " +
      "green and the red in it is unreadable",
  );

  const stage = region(client, CLIENT_TYPES, "export interface GraphStage {", "}");
  assert.match(stage, /readonly id: GraphStageId;/);
  assert.match(stage, /readonly state: GraphStageState;/);
  const stageState = region(client, CLIENT_TYPES, "export type GraphStageState =", ";");
  // `unresolved` IS THE MEMBER WITH THE ARGUMENT BEHIND IT. Without it a stage
  // that was running when the run stopped has to be drawn as `pending` ("still to
  // come", on a run that is over) or `failed` (a claim nothing made). The client's
  // older `SpecStageState` had four members and chose `pending`.
  assert.match(
    stageState,
    /"unresolved"/,
    "the client's GraphStageState has no `unresolved`, so a stage the run abandoned must be " +
      "drawn as pending or as failed, and both of those are claims the stream never made",
  );

  const state = region(client, CLIENT_TYPES, "export interface GraphState {", "}");
  assert.match(
    state,
    /readonly stages\?: readonly GraphStage\[\];/,
    "the client's GraphState does not carry the pre-build lane as an optional list of GraphStage",
  );
});

// THE `todo` OPTION IS GONE, AND ITS REMOVAL IS THE FIX. This is the one place
// the optional `stages` field can be dropped without a compile error:
// `use-run-graph.ts` rebuilds the SNAPSHOT field by field, and the snapshot is the
// only thing a FINISHED run ever gets — the socket is never opened for one
// (`use-run-stream.ts:820-822`). So the lane would fold correctly on the server,
// serialise correctly, arrive correctly, and be discarded one line before it
// reached the canvas, on exactly the runs the owner opens after the fact.
//
// WHY IT WAS MARKED, AND WHY THAT EXPIRED. The mark was a handoff: `use-run-graph.ts`
// belonged to another wave, and a red suite blocks every agent in this tree. The
// handoff was honoured — `dashboard/src/lib/use-run-graph.ts` now reads
// `stages: data.stages ?? [],` inside the snapshot dispatch — but the option was
// left behind. node's runner counts a `todo` under `ℹ todo`, separately from pass
// and fail, so from the moment the blocker shipped this check COULD NOT FAIL THE
// SUITE. It guarded nothing while reading as though it did, which is the exact
// shape of defect this file exists to catch. Removed 2026-08-09; the suite now
// reports `todo 0` for this file, which is the observable proof.
//
// PROVEN ABLE TO GO RED, 2026-08-09: the client tree was copied to a scratch
// directory with the `stages:` line deleted and CLIENT_GRAPH_HOOK pointed at the
// copy — the assertion below fired with its own message. The source file was never
// written to; other agents are in this tree.
test(
  "CONTRACT: the browser's snapshot carries the pre-build lane",
  () => {
    const snapshot = region(
      readClient(CLIENT_GRAPH_HOOK),
      CLIENT_GRAPH_HOOK,
      // The COMMA is what makes this the dispatch and not the `Action` union
      // member a few lines above it, which spells the same key with a semicolon.
      'kind: "snapshot",',
      "});",
    );
    assert.match(
      snapshot,
      /stages: data\.stages/,
      "use-run-graph.ts rebuilds the snapshot as {nodes, edges, inventory} and drops `stages`. " +
        "A finished run never opens the socket, so the snapshot is the only place its pre-build " +
        "lane can come from, and this line is where it is thrown away. Fix: " +
        "`stages: data.stages ?? []`, then make the field required in both api-types.ts files.",
    );
  },
);
