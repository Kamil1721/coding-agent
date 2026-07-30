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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// The classifier is imported by the count's own test on purpose: the number is
// only interesting because four failure branches compare against it, and a test
// that stopped at the integer would not have caught what the integer decided.
import { classifyDesignLane } from "./design-outcome.js";
import {
  DESIGN_MANIFEST_FILE,
  countDesignPngs,
  emptyManifest,
  manifestPathFor,
  parseDesignManifest,
  pruneMissingRefs,
  readDesignDirection,
  readDesignManifest,
  serialiseDesignManifest,
  toVisualManifest,
  writeDesignManifest,
  type DesignLock,
  type DesignManifest,
} from "./design-manifest.js";

const WS = "/runs/r1/workspace";
const REF = `${WS}/design-refs/01-hero.png`;

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
    refs: [{ path: REF, section: "hero", aspect: "17:11", intent: "x" }],
  });
  assert.equal(parseDesignManifest(bad, WS), null);
});

test("the on-disk key is `locked` (§17.1) and the in-memory field is `lockedMockup`", () => {
  const withLock = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x" }],
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
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x" }],
    locked: `${WS}/design-refs/99-invented.png`,
  });
  assert.equal(parseDesignManifest(forged, WS)?.lockedMockup, null);
});

test("2c widens without a breaking change: an unknown-but-optional field parses", () => {
  // §7.6.3 adds `animate: boolean`. A 2b reader must accept a 2c file, and a 2c
  // reader must accept a 2b file, with NO version bump — that is the contract.
  const from2c = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x", animate: true }],
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
    refs: [{ path: png, section: "hero", aspect: "16:9", intent: "x" }],
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
    refs: [{ path: png, section: "hero", aspect: "21:9", intent: "the world journey opens" }],
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
      { path: present, section: "hero", aspect: "16:9", intent: "x" },
      { path: absent, section: "work", aspect: "16:9", intent: "y" },
    ],
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
  assert.equal(pruneMissingRefs({ ...manifest, refs: [manifest.refs[0]!], lockedMockup: present }).lockedMockup, present);
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
  }));
  const classified = classifyDesignLane({
    mode: "full",
    manifest: { version: 1, refs, lockedMockup: null, lockedBy: null, lockedReason: null, lockedAt: null },
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
