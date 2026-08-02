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
const CLIENT_LIB = join(CLIENT_SRC, "lib");
const CLIENT_TYPES = join(CLIENT_LIB, "api-types.ts");
const CLIENT_STREAM = join(CLIENT_LIB, "use-run-stream.ts");
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
    fields: ["awaiting", "mockups", "locked", "lockedBy", "reason"],
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
