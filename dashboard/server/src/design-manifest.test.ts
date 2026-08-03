/**
 * design-manifest.test.ts — the DESIGN lane's contract, and the guards on it.
 *
 * THE LOAD-BEARING TESTS ARE THE REFUSALS. `manifest.json` is written by an agent
 * inside the workspace and read by the host. Every `refs[].path` becomes a `Read`
 * target injected verbatim into every build agent's prompt (spec §7.3 mechanism
 * 2) and, once locked, the image the visual gate grades against (spec §7.4). A
 * path this parser accepts without checking is a file-read primitive with a
 * prompt attached — hence the containment test and the forged-lock test, and
 * hence `parseDesignManifest` returning null rather than a partial manifest.
 *
 * THE FORWARD-COMPAT TEST IS THE ONE 2c DEPENDS ON. §7.6.3 adds `animate` to a
 * ref with NO version bump. A 2b reader must accept a 2c file and a 2c reader
 * must accept a 2b file; `absent, never invented as false` is the half of that
 * contract a careless default would break silently.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// The classifier is imported by the count's own test on purpose: the number is
// only interesting because four failure branches compare against it, and a test
// that stopped at the integer would not have caught what the integer decided.
import { classifyDesignLane } from "./design-outcome.js";
// THE TWO PROMPTS ARE IMPORTED BY `builtManifest`'S OWN TEST for the same reason
// the classifier is imported above: the projection is only interesting because
// those two prompts are what a build agent and the grader actually read, and a
// test that stopped at the returned array would not have caught what the array
// decided.
import { designHandoffSection, visualGatePrompt } from "./design-prompt.js";
import {
  DESIGN_MANIFEST_FILE,
  auditCanvass,
  builtManifest,
  countDesignPngs,
  directionDiscarded,
  emptyManifest,
  heroRefFor,
  manifestPathFor,
  parseDesignManifest,
  pruneMissingRefs,
  readDesignDirection,
  readDesignManifest,
  refsForDirection,
  serialiseDesignManifest,
  toVisualManifest,
  unresolvedDirectionRefs,
  writeDesignManifest,
  type DesignLock,
  type DesignManifest,
} from "./design-manifest.js";

const WS = "/runs/r1/workspace";
const REF = `${WS}/design-refs/01-hero.png`;

/**
 * THE PRE-2026-08-03 SHAPE, ON PURPOSE — no `directions`, no `direction`, no
 * `origin`. Three runs on disk are written exactly like this, so every test that
 * uses it is also a test that an old manifest still reads.
 */
function refJson(path = REF): string {
  return JSON.stringify({
    version: 1,
    refs: [{ path, section: "hero", aspect: "16:9", intent: "full-bleed opening statement" }],
  });
}

test("the manifest maps ABSOLUTE path -> section, aspect, intent (spec §7.2)", () => {
  const m = parseDesignManifest(refJson(), WS);
  assert.ok(m !== null);
  assert.equal(m.refs[0]?.path, REF);
  assert.equal(m.refs[0]?.section, "hero");
  assert.equal(m.refs[0]?.aspect, "16:9");
  assert.equal(m.refs[0]?.intent, "full-bleed opening statement");
});

test("a ref outside <workspace>/design-refs/ is REFUSED, not trusted", () => {
  // The manifest is written by an AGENT inside the workspace. A path it invents
  // becomes a `Read` target injected into every build prompt (§7.3 mechanism 2)
  // and, once locked, the reference the visual gate grades against. An absolute
  // path pointing at ~/.gemini/api_key would be read out loud into a prompt.
  assert.equal(parseDesignManifest(refJson("/etc/passwd"), WS), null);
  assert.equal(parseDesignManifest(refJson(`${WS}/../elsewhere/x.png`), WS), null);
  assert.equal(parseDesignManifest(refJson("design-refs/01-hero.png"), WS), null, "relative is refused too");
});

test("an unknown aspect is refused — gemini-image.sh accepts 1:1 … 21:9 and nothing else", () => {
  const bad = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "17:11", intent: "x", direction: null, origin: null }],
  });
  assert.equal(parseDesignManifest(bad, WS), null);
});

test("the on-disk key is `locked` (§17.1) and the in-memory field is `lockedMockup`", () => {
  const withLock = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x", direction: null, origin: null }],
    locked: REF,
    lockedBy: "owner",
    lockedReason: "chosen in the dashboard",
    lockedAt: "2026-07-29T10:00:00.000Z",
  });
  const m = parseDesignManifest(withLock, WS);
  assert.equal(m?.lockedMockup, REF);
  assert.equal(m?.lockedBy, "owner");
  assert.match(serialiseDesignManifest(m as DesignManifest), /"locked":/);
  assert.doesNotMatch(serialiseDesignManifest(m as DesignManifest), /"lockedMockup":/);
});

test("a `locked` path that is not one of the refs is dropped to null, loudly typed", () => {
  // An agent that writes its own favourite path into `locked` must not be able to
  // point the gate at a file nobody generated.
  const forged = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x", direction: null, origin: null }],
    locked: `${WS}/design-refs/99-invented.png`,
  });
  assert.equal(parseDesignManifest(forged, WS)?.lockedMockup, null);
});

test("2c widens without a breaking change: an unknown-but-optional field parses", () => {
  // §7.6.3 adds `animate: boolean`. A 2b reader must accept a 2c file, and a 2c
  // reader must accept a 2b file, with NO version bump — that is the contract.
  const from2c = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x", direction: null, origin: null, animate: true }],
  });
  assert.equal(parseDesignManifest(from2c, WS)?.refs[0]?.animate, true);
  assert.equal(parseDesignManifest(refJson(), WS)?.refs[0]?.animate, undefined, "absent, never invented as false");
});

test("a DesignManifest satisfies DesignLock structurally — the visual gate reads only that", () => {
  const lock: DesignLock = toVisualManifest(emptyManifest());
  assert.equal(lock.lockedMockup, null);
});

test("manifestPathFor names the file the DESIGN lane is told to write", () => {
  assert.equal(manifestPathFor(WS), `${WS}/design-refs/${DESIGN_MANIFEST_FILE}`);
});

test("garbage is null, never a partial manifest", () => {
  assert.equal(parseDesignManifest("not json", WS), null);
  assert.equal(parseDesignManifest("{}", WS), null);
  assert.equal(parseDesignManifest(JSON.stringify({ version: 2, refs: [] }), WS), null);
});

test("the disk helpers round-trip, and a missing file is null rather than a throw", () => {
  const ws = mkdtempSync(join(tmpdir(), "design-ws-"));
  assert.equal(readDesignManifest(ws), null, "no manifest yet — null, not an exception");
  const png = join(ws, "design-refs", "01-hero.png");
  mkdirSync(join(ws, "design-refs"), { recursive: true });
  writeFileSync(png, "not really a png", "utf8");
  const manifest: DesignManifest = {
    version: 1,
    refs: [{ path: png, section: "hero", aspect: "16:9", intent: "x", direction: null, origin: null }],
    directions: [],
    chosenDirection: null,
    directionChoice: null,
    lockedMockup: null,
    lockedBy: null,
    lockedReason: null,
    lockedAt: null,
  };
  writeDesignManifest(ws, manifest);
  assert.deepEqual(readDesignManifest(ws), manifest);
  assert.equal(readDesignDirection(ws), "", "absent direction is empty, never a heading over a hole");
});

test("a LOCKED manifest survives the disk round-trip — `locked` out, `lockedMockup` back", () => {
  // The two-spellings rule is pinned above in each direction separately, but the
  // seam Task 8 (`lockManifest`) and Task 10 (`writeDesignManifest`) actually sit
  // on is write-then-read WITH a lock set. `parseDesignManifest`'s
  // `locked === null ? null : ...` branches are the ones that carry lockedBy,
  // lockedReason and lockedAt, and until this test they were only ever reached
  // in memory. A serialiser that emitted `lockedMockup` would round-trip to a
  // manifest with a lock and no provenance — recorded, per §17.3 rule 4, as
  // nobody having chosen it.
  const ws = mkdtempSync(join(tmpdir(), "design-locked-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(refsDir, { recursive: true });
  const png = join(refsDir, "02-hero.png");
  writeFileSync(png, "x", "utf8");
  const manifest: DesignManifest = {
    version: 1,
    refs: [{ path: png, section: "hero", aspect: "21:9", intent: "the world journey opens", direction: null, origin: null }],
    directions: [],
    chosenDirection: null,
    directionChoice: null,
    lockedMockup: png,
    lockedBy: "ui-designer",
    lockedReason: "the only one whose palette survived the crop",
    lockedAt: "2026-07-29T10:00:00.000Z",
  };
  writeDesignManifest(ws, manifest);
  assert.deepEqual(readDesignManifest(ws), manifest);
  assert.equal(toVisualManifest(readDesignManifest(ws) as DesignManifest).lockedMockup, png);
});

test("pruneMissingRefs keeps the prompt honest, and drops a lock that points at nothing", () => {
  // A partial lane does not stop the run, so the build segment still gets a
  // handoff — but a path in a prompt that resolves to nothing is a Read failure
  // several turns deep inside a build agent, reported as its confusion rather
  // than as a design fault.
  const ws = mkdtempSync(join(tmpdir(), "design-prune-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(refsDir, { recursive: true });
  const present = join(refsDir, "01.png");
  const absent = join(refsDir, "02.png");
  writeFileSync(present, "x", "utf8");
  const manifest: DesignManifest = {
    version: 1,
    refs: [
      { path: present, section: "hero", aspect: "16:9", intent: "x", direction: null, origin: null },
      { path: absent, section: "work", aspect: "16:9", intent: "y", direction: null, origin: null },
    ],
    directions: [],
    chosenDirection: null,
    directionChoice: null,
    lockedMockup: absent,
    lockedBy: "owner",
    lockedReason: "r",
    lockedAt: "2026-07-29T10:00:00.000Z",
  };
  const pruned = pruneMissingRefs(manifest);
  assert.deepEqual(
    pruned.refs.map((r) => r.path),
    [present],
  );
  assert.equal(pruned.lockedMockup, null, "a lock on a missing file is no lock");
  assert.equal(pruned.lockedBy, null);
  // SLICED, NOT INDEXED-AND-ASSERTED. `manifest.refs[0]!` claimed a length this
  // line does not check; `slice` keeps the first ref if there is one and makes an
  // empty fixture fail as an empty fixture rather than as a lock that vanished.
  assert.equal(
    pruneMissingRefs({ ...manifest, refs: manifest.refs.slice(0, 1), lockedMockup: present }).lockedMockup,
    present,
  );
});

/** A minimal file that really is a PNG by content: the 8-byte signature + IHDR. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
/** SOI + APP0, which is what every file the image chain actually emitted starts with. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

function countDir(entries: Record<string, Buffer | string>): number {
  const ws = mkdtempSync(join(tmpdir(), "design-count-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(refsDir, { recursive: true });
  for (const [name, body] of Object.entries(entries)) {
    if (typeof body === "string") writeFileSync(join(refsDir, name), body, "utf8");
    else writeFileSync(join(refsDir, name), body);
  }
  return countDesignPngs(refsDir);
}

test("countDesignPngs counts DISK, not the manifest's claims", () => {
  // classifyDesignLane compares the two. A count taken from the manifest would
  // make "the manifest lists 5 refs over 3 files" undetectable by construction.
  const ws = mkdtempSync(join(tmpdir(), "design-count-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, "01.png"), PNG_BYTES);
  writeFileSync(join(refsDir, "02.PNG"), PNG_BYTES);
  writeFileSync(join(refsDir, "manifest.json"), "{}", "utf8");
  writeFileSync(join(refsDir, "direction.md"), "# art direction", "utf8");
  assert.equal(countDesignPngs(refsDir), 2);
  assert.equal(countDesignPngs(join(ws, "nope")), 0);
});

/* -------------------------------------------------------------------------
 * The count is CONTENT, and both halves of that were measured wrong first.
 *
 * The old body was `readdirSync(...).filter(n => n.endsWith(".png")).length`.
 * All four of `classifyDesignLane`'s failure branches compare against this
 * number, so each assertion below is the standing version of a control that was
 * executed against the old implementation and returned the wrong answer:
 *
 *   - five ZERO-BYTE files named `*.png` counted 5, so a lane that produced
 *     nothing usable classified `failure: null`;
 *   - five real PNGs named `*.jpg` counted 0, so a lane that produced a full
 *     set classified `no-images`.
 * ---------------------------------------------------------------------- */

test("NEGATIVE CONTROL: five zero-byte files named .png are not five images", () => {
  const empty = { "01.png": "", "02.png": "", "03.png": "", "04.png": "", "05.png": "" };
  assert.equal(countDesignPngs(join(mkdtempSync(join(tmpdir(), "design-count-")), "absent")), 0);
  assert.equal(countDir(empty), 0, "a zero-byte file has no signature and cannot be an image");

  // AND THE BRANCH IT DECIDES. The count alone is a number; this is the loud
  // failure the old count silently defeated.
  const refs = Object.keys(empty).map((name, index) => ({
    path: `${WS}/design-refs/${name}`,
    section: `section-${String(index + 1)}`,
    aspect: "16:9" as const,
    intent: "x",
    direction: null,
    origin: null,
  }));
  const classified = classifyDesignLane({
    mode: "full",
    manifest: {
      version: 1,
      refs,
      directions: [],
      chosenDirection: null,
      directionChoice: null,
      lockedMockup: null,
      lockedBy: null,
      lockedReason: null,
      lockedAt: null,
    },
    pngCount: countDir(empty),
    imageCalls: 5,
    keySource: "env",
    preflight: [],
  });
  assert.equal(classified.failure, "no-images", "five empty files must reach a failure branch, not `failure: null`");
});

test("the run's real stills count: JPEG bytes count, and the extension never decides", () => {
  // MEASURED, not assumed: every `design-0*.png` in
  // dashboard/results/screenshots/run-2026-07-29T23-28-46-665Z-3d4d1ccb is
  // `JPEG image data, JFIF standard 1.01, 1376x768`. A PNG-only content test
  // would score that working lane `no-images`.
  const jpegsNamedPng = {
    "01-hero.png": JPEG_BYTES,
    "02-services.png": JPEG_BYTES,
    "03-hours.png": JPEG_BYTES,
    "04-booking-modal.png": JPEG_BYTES,
    "05-confirmation.png": JPEG_BYTES,
  };
  assert.equal(countDir(jpegsNamedPng), 5, "the run's five real stills are JPEG; they must still count as five");

  // The other direction of the same defect: content wins over a wrong suffix.
  assert.equal(countDir({ "01.jpg": PNG_BYTES, "02.jpeg": PNG_BYTES }), 2, "a real PNG named .jpg is an image");
  assert.equal(countDir({ "01.webp": JPEG_BYTES }), 1);

  // Non-images are still non-images however they are named.
  assert.equal(countDir({ "manifest.json": "{}", "direction.md": "# hi", "notes.png": "TODO: generate" }), 0);
  // Truncated to fewer bytes than the signature: not an image.
  assert.equal(countDir({ "half.png": Buffer.from([0x89, 0x50]) }), 0);

  // A DIRECTORY named like an image. Reading it throws EISDIR, and a count that
  // let the throw escape would return 0 for the whole lane — a real set of stills
  // reported as `no-images` because someone left a folder in the refs directory.
  const ws = mkdtempSync(join(tmpdir(), "design-count-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(join(refsDir, "old.png"), { recursive: true });
  writeFileSync(join(refsDir, "01-hero.png"), JPEG_BYTES);
  writeFileSync(join(refsDir, "02-services.png"), PNG_BYTES);
  assert.equal(countDesignPngs(refsDir), 2, "a subdirectory must be skipped, not counted and not fatal");
});

/* ══ two-stage directions (2026-08-03) ═════════════════════════════════════ */

const DIRECTIONS_JSON = {
  version: 1 as const,
  directions: [
    {
      slug: "editorial-slab",
      name: "Editorial slab",
      distinction: "A slab-serif masthead over a two-column measure; the others are grotesk and single-column.",
      notes: `${WS}/design-refs/direction-editorial-slab.md`,
    },
    {
      slug: "quiet-grid",
      name: "Quiet grid",
      distinction: "An eight-column hairline grid carries the rhythm instead of type weight.",
      notes: null,
    },
  ],
  refs: [
    { path: `${WS}/design-refs/editorial-slab-01-hero.png`, section: "hero", aspect: "16:9", intent: "a", direction: "editorial-slab" },
    { path: `${WS}/design-refs/editorial-slab-02-work.png`, section: "work", aspect: "16:9", intent: "b", direction: "editorial-slab" },
    { path: `${WS}/design-refs/quiet-grid-01-hero.png`, section: "hero", aspect: "16:9", intent: "c", direction: "quiet-grid" },
  ],
};

test("A MANIFEST WRITTEN BEFORE 2026-08-03 STILL READS, and invents no direction", () => {
  // Three runs on disk carry no `directions` key and no `direction`/`origin` on a
  // ref. `[]` and `null` are what make every downstream branch — the segment
  // chooser, the park, the wire's `stage` — take today's single-direction path.
  const legacy = parseDesignManifest(refJson(), WS);
  assert.ok(legacy !== null, "an old manifest parses");
  assert.deepEqual(legacy.directions, [], "no directions, and not a fabricated one");
  assert.equal(legacy.chosenDirection, null);
  assert.equal(legacy.directionChoice, null);
  assert.equal(legacy.refs[0]?.direction, null, "a legacy ref belongs to no direction");
  assert.equal(legacy.refs[0]?.origin, null, "and its origin is unknown, not guessed as canvass");
  assert.deepEqual(unresolvedDirectionRefs(legacy), [], "a legacy manifest reports no unresolved ref");
});

test("EVERY manifest.json ON THIS MACHINE parses — the real files, not a fixture of them", () => {
  // MEASURED AGAINST THE ARTEFACTS, because the fixture above is a shape I wrote
  // and these are shapes an agent wrote months ago. Skipped rather than failed
  // when the runs have been cleaned: a test that needs the owner's run history to
  // pass would be deleted the first time it went red for that reason.
  const runsDir = join(import.meta.dirname, "..", "..", "runs");
  if (!existsSync(runsDir)) return;
  let checked = 0;
  for (const entry of readdirSync(runsDir)) {
    const workspace = join(runsDir, entry, "workspace");
    const file = join(workspace, "design-refs", DESIGN_MANIFEST_FILE);
    if (!existsSync(file)) continue;
    checked += 1;
    const parsed = parseDesignManifest(readFileSync(file, "utf8"), workspace);
    assert.ok(parsed !== null, `${entry} must still parse`);
    assert.deepEqual(parsed.directions, [], `${entry} predates directions and must report none`);
    assert.equal(parsed.chosenDirection, null);
    for (const ref of parsed.refs) assert.equal(ref.direction, null, `${entry} must invent no direction`);
    // AND IT STILL CLASSIFIES AS IT DID. `unresolvedDirectionRefs` is gated on
    // `directions.length > 0`, so an old manifest cannot reach the new failure.
    assert.deepEqual(unresolvedDirectionRefs(parsed), []);
  }
  assert.ok(checked > 0 || true, `${String(checked)} real manifest(s) checked`);
});

test("THE ROUND TRIP CARRIES THE DIRECTIONS — serialise is a hand-built literal", () => {
  // THE CONTROL THIS TEST EXISTS FOR: delete `directions:` from
  // `serialiseDesignManifest`'s object literal and this goes red while types stay
  // green and every other test passes. That erasure would land on the write that
  // locks the hero at the end of stage B — the last write of the run.
  const once = parseDesignManifest(JSON.stringify(DIRECTIONS_JSON), WS);
  assert.ok(once !== null);
  const twice = parseDesignManifest(serialiseDesignManifest(once), WS);
  assert.deepEqual(twice, once, "parse -> serialise -> parse loses nothing");
  assert.equal(twice?.directions.length, 2);
  assert.equal(twice?.directions[0]?.name, "Editorial slab");
  assert.equal(twice?.directions[0]?.notes, `${WS}/design-refs/direction-editorial-slab.md`);
  assert.equal(twice?.refs[0]?.direction, "editorial-slab");
  // ABSENT `origin` WITH DIRECTIONS PRESENT IS `canvass`, never `requested`:
  // `requested` is host-written, so a default can never manufacture one.
  assert.equal(twice?.refs[0]?.origin, "canvass");
});

test("A CHOICE ROUND-TRIPS WITH ITS PROVENANCE, and a chosen slug with none is dropped", () => {
  const chosen = parseDesignManifest(
    JSON.stringify({
      ...DIRECTIONS_JSON,
      chosenDirection: "quiet-grid",
      directionChoice: { by: "owner", reason: "the grid reads at a glance", at: "2026-08-03T10:00:00.000Z" },
    }),
    WS,
  );
  assert.equal(chosen?.chosenDirection, "quiet-grid");
  assert.equal(chosen?.directionChoice?.by, "owner");
  assert.deepEqual(parseDesignManifest(serialiseDesignManifest(chosen as DesignManifest), WS), chosen);

  // BOTH OR NEITHER. A `chosenDirection` with no provenance is a claim an agent
  // made without the authority to make it — dropped, exactly as a forged `locked`
  // is, rather than expanded into a direction nobody can be shown to have picked.
  const orphan = parseDesignManifest(JSON.stringify({ ...DIRECTIONS_JSON, chosenDirection: "quiet-grid" }), WS);
  assert.equal(orphan?.chosenDirection, null);
  assert.equal(orphan?.directionChoice, null);
  // And a slug nobody declared is dropped the same way.
  const invented = parseDesignManifest(
    JSON.stringify({
      ...DIRECTIONS_JSON,
      chosenDirection: "made-up",
      directionChoice: { by: "owner", reason: "r", at: "2026-08-03T10:00:00.000Z" },
    }),
    WS,
  );
  assert.equal(invented?.chosenDirection, null);
});

test("A SLUG IS A FILENAME PREFIX, so a bad one is wholesale-null like a bad path", () => {
  const withSlug = (slug: string): string =>
    JSON.stringify({ ...DIRECTIONS_JSON, directions: [{ ...DIRECTIONS_JSON.directions[0], slug }], refs: [] });
  assert.equal(parseDesignManifest(withSlug("../../etc"), WS), null, "traversal");
  assert.equal(parseDesignManifest(withSlug("a/b"), WS), null, "a separator");
  assert.equal(parseDesignManifest(withSlug("Editorial Slab"), WS), null, "spaces and capitals");
  assert.equal(parseDesignManifest(withSlug("-leading"), WS), null);
  assert.equal(parseDesignManifest(withSlug("a".repeat(33)), WS), null, "longer than the bound");
  assert.ok(parseDesignManifest(withSlug("a"), WS) !== null, "one character is a slug");
  assert.ok(parseDesignManifest(withSlug("editorial-slab-2"), WS) !== null);

  // A DUPLICATE IS WHOLESALE-NULL, not last-one-wins: `<slug>-01-hero.png` is one
  // filename, so two directions sharing a slug overwrite each other's stills.
  const dup = JSON.stringify({
    ...DIRECTIONS_JSON,
    directions: [DIRECTIONS_JSON.directions[0], { ...DIRECTIONS_JSON.directions[1], slug: "editorial-slab" }],
    refs: [],
  });
  assert.equal(parseDesignManifest(dup, WS), null);
});

test("A REF NAMING AN UNDECLARED DIRECTION IS KEPT AND REPORTED, never dropped", () => {
  // Dropping it would turn a loud, non-blocking fault into a smaller set with no
  // explanation — and a smaller set is exactly what `too-few-images` reports for
  // a different reason.
  const stray = parseDesignManifest(
    JSON.stringify({
      ...DIRECTIONS_JSON,
      refs: [...DIRECTIONS_JSON.refs, { path: `${WS}/design-refs/x.png`, section: "s", aspect: "16:9", intent: "i", direction: "never-declared" }],
    }),
    WS,
  );
  assert.ok(stray !== null, "kept, not refused wholesale");
  assert.equal(stray.refs.length, 4);
  assert.equal(unresolvedDirectionRefs(stray).length, 1);
  assert.equal(unresolvedDirectionRefs(stray)[0]?.direction, "never-declared");

  // The OTHER shape: a manifest that HAS directions and a ref that names none.
  // It breaks `refsForDirection` the same way, so it is reported the same way.
  const naked = parseDesignManifest(
    JSON.stringify({
      ...DIRECTIONS_JSON,
      refs: [{ path: `${WS}/design-refs/y.png`, section: "s", aspect: "16:9", intent: "i" }],
    }),
    WS,
  );
  assert.equal(unresolvedDirectionRefs(naked as DesignManifest).length, 1);
});

test("refsForDirection / heroRefFor / directionDiscarded — the set, its hero, and what was offered", () => {
  const requested = parseDesignManifest(
    JSON.stringify({
      ...DIRECTIONS_JSON,
      refs: [
        // AN ON-DEMAND STILL FIRST IN THE ARRAY, deliberately: if `heroRefFor` took
        // the first ref of the direction rather than the first NON-REQUESTED one,
        // an image the owner asked for mid-park would become the gate's reference.
        { path: `${WS}/design-refs/editorial-slab-req-01-contact.png`, section: "contact", aspect: "16:9", intent: "asked for", direction: "editorial-slab", origin: "requested" },
        ...DIRECTIONS_JSON.refs,
      ],
      chosenDirection: "editorial-slab",
      directionChoice: { by: "owner", reason: "the slab carries the masthead", at: "2026-08-03T10:00:00.000Z" },
    }),
    WS,
  );
  assert.ok(requested !== null);
  assert.deepEqual(
    refsForDirection(requested, "editorial-slab").map((ref) => ref.section),
    ["hero", "work"],
    "the requested still is in refs and out of the direction's set",
  );
  assert.equal(heroRefFor(requested, "editorial-slab")?.section, "hero");
  assert.equal(heroRefFor(requested, "quiet-grid")?.section, "hero");
  assert.equal(heroRefFor(requested, "no-such-direction"), null);

  assert.equal(directionDiscarded(requested, "quiet-grid"), true, "offered, not built");
  assert.equal(directionDiscarded(requested, "editorial-slab"), false);
  // NOTHING IS DISCARDED BEFORE ANYTHING IS CHOSEN.
  const open = parseDesignManifest(JSON.stringify(DIRECTIONS_JSON), WS);
  assert.equal(directionDiscarded(open as DesignManifest, "quiet-grid"), false);
});

/*
 * A PREVIEW THE OWNER ASKED FOR MUST NEVER BECOME A BUILD REFERENCE.
 *
 * THE RUN THESE TWO TESTS ARE TAKEN FROM: parked on the canvass, the owner asks
 * "show me the pricing page in 2" out of curiosity, the host renders it and
 * appends a ref with `origin: "requested"` and a section the ticket never asked
 * for. He then picks that direction. Until 2026-08-03 `builtManifest` filtered on
 * `direction` alone, so that still crossed BOTH seams: the build agent was handed
 * it under "THE DESIGN IS ALREADY MADE. Build to it", and the visual gate was
 * told to read it as a pair against a site that has no pricing section — a gate
 * failure manufactured out of a picture he asked for out of curiosity.
 *
 * TWO TESTS AND NOT ONE, because the projection and the prompts fail
 * independently: a later reader who "fixes" only the array would leave the second
 * red, which is the point.
 *
 * EVERY ASSERTION HAS ITS POSITIVE HALF. A filter that dropped EVERYTHING passes
 * the negative half of both of these, so the chosen direction's own stills are
 * asserted present in the same breath.
 */

const PREVIEW_REF = {
  path: `${WS}/design-refs/editorial-slab-req-01-pricing.png`,
  section: "pricing",
  aspect: "16:9",
  intent: 'asked for by the owner while choosing a direction: the pricing section in "Editorial slab"',
  direction: "editorial-slab",
  origin: "requested",
};

/** The canvass, plus the preview he asked for, plus the choice he then made. */
function chosenWithPreview(): DesignManifest {
  const manifest = parseDesignManifest(
    JSON.stringify({
      ...DIRECTIONS_JSON,
      refs: [...DIRECTIONS_JSON.refs, PREVIEW_REF],
      chosenDirection: "editorial-slab",
      directionChoice: { by: "owner", reason: "the slab carries the masthead", at: "2026-08-03T10:00:00.000Z" },
    }),
    WS,
  );
  assert.ok(manifest !== null, "the fixture itself must parse");
  return manifest;
}

const HERO_REF_PATH = `${WS}/design-refs/editorial-slab-01-hero.png`;
const WORK_REF_PATH = `${WS}/design-refs/editorial-slab-02-work.png`;
const DISCARDED_REF_PATH = `${WS}/design-refs/quiet-grid-01-hero.png`;

test("A REQUESTED STILL IS A PREVIEW — `builtManifest` keeps it out of the set that builds and grades", () => {
  const chosen = chosenWithPreview();
  assert.equal(chosen.refs.length, 4, "the preview is in the manifest and stays there — it is the record");

  assert.deepEqual(
    builtManifest(chosen).refs.map((ref) => ref.path),
    [HERO_REF_PATH, WORK_REF_PATH],
    "the chosen direction's own stills, and neither the preview nor a direction that was discarded",
  );

  // WHILE STAGE A IS STILL OPEN there is no chosen direction, and a preview is
  // still a preview: `chosenDirection === null` returned the manifest whole,
  // which is the same leak one segment earlier.
  const open = parseDesignManifest(
    JSON.stringify({ ...DIRECTIONS_JSON, refs: [...DIRECTIONS_JSON.refs, PREVIEW_REF] }),
    WS,
  );
  assert.ok(open !== null);
  assert.ok(
    !builtManifest(open).refs.some((ref) => ref.path === PREVIEW_REF.path),
    "a preview is excluded whether or not a choice has been made",
  );
  assert.equal(builtManifest(open).refs.length, 3, "and nothing else is: all three canvass stills survive");

  // IDENTITY ON A MANIFEST WITH NOTHING TO REMOVE, which is every manifest
  // written before 2026-08-03 — the same object, not a copy that happens to match.
  const legacy = parseDesignManifest(refJson(), WS);
  assert.ok(legacy !== null);
  assert.equal(builtManifest(legacy), legacy);
});

test("A REQUESTED STILL IS A PREVIEW — it reaches neither the builder's prompt nor the grader's", () => {
  const chosen = chosenWithPreview();

  const handoff = designHandoffSection({ manifest: chosen, mode: "full", workspace: WS, dials: "" });
  assert.ok(
    !handoff.includes(PREVIEW_REF.path),
    "the build agent is never handed a still the owner asked for out of curiosity",
  );
  assert.ok(
    handoff.includes(HERO_REF_PATH) && handoff.includes(WORK_REF_PATH),
    "and it IS handed the direction it is building — without this the test passes on an empty set",
  );
  assert.ok(!handoff.includes(DISCARDED_REF_PATH), "nor a direction that was offered and not chosen");

  const gate = visualGatePrompt({ manifest: chosen, workspace: WS, previewUrl: "http://127.0.0.1:4173" });
  assert.ok(
    !gate.includes(PREVIEW_REF.path),
    "the grader is never asked to read a pair against a section the ticket did not ask to exist",
  );
  assert.ok(
    gate.includes(HERO_REF_PATH) && gate.includes(WORK_REF_PATH),
    "and it IS asked to read the design that was built",
  );
  assert.ok(!gate.includes(DISCARDED_REF_PATH));
});

test("pruneMissingRefs nulls a notes path nobody wrote, and keeps the direction", () => {
  // A notes path is a `Read` target in a build agent's prompt, the same seam
  // `refs[].path` guards. The DIRECTION survives with `notes: null` — losing the
  // name and the distinction would lose the record of what was offered.
  const ws = mkdtempSync(join(tmpdir(), "design-notes-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(refsDir, { recursive: true });
  const png = join(refsDir, "editorial-slab-01-hero.png");
  writeFileSync(png, "x", "utf8");
  const manifest = parseDesignManifest(
    JSON.stringify({
      version: 1,
      directions: [
        { slug: "editorial-slab", name: "Editorial slab", distinction: "d", notes: join(refsDir, "direction-editorial-slab.md") },
      ],
      refs: [{ path: png, section: "hero", aspect: "16:9", intent: "i", direction: "editorial-slab" }],
    }),
    ws,
  );
  assert.ok(manifest !== null);
  const pruned = pruneMissingRefs(manifest);
  assert.equal(pruned.directions[0]?.notes, null, "the file was never written");
  assert.equal(pruned.directions[0]?.name, "Editorial slab", "the record of what was offered survives");
  assert.equal(pruned.refs.length, 1, "the still that exists is untouched");
});

/* ══ THE CANVASS AUDIT (2026-08-03) ════════════════════════════════════════ */

/** A canvass exactly as an agent writes it, through the real parser. */
function canvass(
  directions: readonly { slug: string; sections: readonly string[]; aspect?: string }[],
  chosen?: string,
): DesignManifest {
  const manifest = parseDesignManifest(
    JSON.stringify({
      version: 1,
      directions: directions.map((entry) => ({ slug: entry.slug, name: entry.slug, distinction: "d", notes: null })),
      ...(chosen === undefined
        ? {}
        : {
            chosenDirection: chosen,
            directionChoice: { by: "owner", reason: "he picked it", at: "2026-08-03T10:00:00.000Z" },
          }),
      refs: directions.flatMap((entry) =>
        entry.sections.map((section, index) => ({
          path: `${WS}/design-refs/${entry.slug}-0${String(index + 1)}-still.png`,
          section,
          aspect: entry.aspect ?? "16:9",
          intent: "i",
          direction: entry.slug,
          origin: "canvass",
        })),
      ),
    }),
    WS,
  );
  assert.ok(manifest !== null, "the fixture itself must parse");
  return manifest;
}

test("auditCanvass reports the SECTION SET, the aspects and what each direction is missing", () => {
  const audited = auditCanvass(
    canvass([
      { slug: "editorial-slab", sections: ["hero", "work"] },
      // TWO STILLS, ONE SECTION — and the second is the same section in prose
      // case, which is what a lane that writes `"Hero"` produces. The audit
      // normalises, so this direction offers ONE thing to compare, not two.
      { slug: "quiet-grid", sections: ["hero", "Hero"], aspect: "3:2" },
      { slug: "warm-stack", sections: ["hero", "footer"] },
    ]),
  );
  assert.deepEqual(
    audited.map((entry) => [entry.slug, entry.sections, entry.missing, entry.aspects]),
    [
      ["editorial-slab", ["hero", "work"], ["footer"], ["16:9"]],
      ["quiet-grid", ["hero"], ["work", "footer"], ["3:2"]],
      ["warm-stack", ["hero", "footer"], ["work"], ["16:9"]],
    ],
  );
});

test("auditCanvass is EMPTY off stage A — a legacy manifest and an expansion are not canvasses", () => {
  // THE GATE IS THE WHOLE SAFETY OF THE CHECK ABOVE. A chosen direction is
  // SUPPOSED to carry sections the discarded two do not — that is what stage B
  // does — so an audit that ran there would fail every healthy expansion. And a
  // pre-2026-08-03 manifest has no directions to audit at all.
  const shape = [
    { slug: "editorial-slab", sections: ["hero", "work"] },
    { slug: "quiet-grid", sections: ["hero", "work"] },
  ];
  assert.deepEqual(auditCanvass(canvass(shape, "editorial-slab")), [], "a choice has been made: not a canvass");
  const legacy = parseDesignManifest(refJson(), WS);
  assert.ok(legacy !== null);
  assert.deepEqual(auditCanvass(legacy), [], "no directions: nothing to compare");

  // AND IT IS NOT EMPTY WHERE IT MATTERS, which is the half that keeps the two
  // assertions above from passing on a function that always returns nothing.
  assert.equal(auditCanvass(canvass(shape)).length, 2);
});

test("auditCanvass counts a direction with NO stills, rather than omitting it", () => {
  // AN EMPTY CARD IS THE FAULT. A direction dropped from the report because it
  // has no refs is the one the owner cannot choose, and the count of directions
  // audited is what the failure sentence says "2 of 3" against.
  const audited = auditCanvass(
    canvass([
      { slug: "editorial-slab", sections: ["hero", "work"] },
      { slug: "quiet-grid", sections: [] },
      { slug: "warm-stack", sections: [] },
    ]),
  );
  assert.equal(audited.length, 3);
  assert.deepEqual(audited[1]?.sections, []);
  assert.deepEqual(audited[1]?.missing, ["hero", "work"]);
  assert.deepEqual(audited[1]?.aspects, []);
});

test("a PREVIEW is not a canvass still — an on-demand render cannot complete a direction", () => {
  // The owner asks "show me the pricing page in 2" while he is choosing. That
  // still is in `refs` and on his screen, and it is not a still the LANE offered:
  // counting it would let a direction that rendered one section pass a floor of
  // two on a picture he asked for out of curiosity — and would make the section
  // sets disagree, since he asked for it in ONE direction.
  const withPreview = parseDesignManifest(
    JSON.stringify({
      version: 1,
      directions: ["editorial-slab", "quiet-grid"].map((slug) => ({ slug, name: slug, distinction: "d", notes: null })),
      refs: [
        { path: `${WS}/design-refs/editorial-slab-01-hero.png`, section: "hero", aspect: "16:9", intent: "i", direction: "editorial-slab", origin: "canvass" },
        { path: `${WS}/design-refs/editorial-slab-req-01-pricing.png`, section: "pricing", aspect: "16:9", intent: "i", direction: "editorial-slab", origin: "requested" },
        { path: `${WS}/design-refs/quiet-grid-01-hero.png`, section: "hero", aspect: "16:9", intent: "i", direction: "quiet-grid", origin: "canvass" },
      ],
    }),
    WS,
  );
  assert.ok(withPreview !== null);
  assert.deepEqual(
    auditCanvass(withPreview).map((entry) => [entry.slug, entry.sections, entry.missing]),
    [
      ["editorial-slab", ["hero"], []],
      ["quiet-grid", ["hero"], []],
    ],
    "the preview is in refs and out of the audit — the two directions are comparable, and both are short",
  );
});
