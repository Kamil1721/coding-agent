/**
 * ticket-refs.test.ts — the identity rule, and the wall between the seats.
 *
 * TWO THINGS HERE CAN ORPHAN EVERY FROZEN SUITE ON DISK OR CORRUPT A VERDICT,
 * and both are silent when they break:
 *
 *   1. A ticket with NO references must digest exactly as it did before this
 *      module existed. Not "equivalently" — the same 16 hex characters. Every
 *      suite already sealed under `dashboard/acceptance/<id>/` is addressed by
 *      that string, and a change would send every future run of an old ticket to
 *      author a fresh suite while the old one sat unreferenced. The golden
 *      literal below is the guard: it fails on ANY change to the composition,
 *      the separator or the digest, including one that is internally consistent.
 *
 *   2. The spec seat is constructed with `tools: []`. Anything about an image
 *      that reaches `Ticket.brief` reaches a seat that cannot open it, and the
 *      suite then contains criteria about a reference nothing looked at. The
 *      test for that is a NEGATIVE one — the path, the filename and the word
 *      "image" must all be absent from the brief — because a positive test that
 *      the builder prompt contains the path would pass just as happily while the
 *      brief leaked it too.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ticketFromStoredBrief, ticketFromText, ticketWithReferences } from "./ticket.js";
import {
  CAPTURE_BLOCK_BEGIN,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  builderReferenceSection,
  composeBrief,
  decodeReferenceDataUrl,
  designReferenceSection,
  digestBytes,
  hasReferences,
  readReferenceManifest,
  referenceDirFor,
  referenceIdentityMaterial,
  ticketProse,
  writeReferenceManifest,
} from "./ticket-refs.js";
import type { ReferenceImage } from "./ticket-refs.js";
import type { SiteCapture } from "./site-capture.js";

const PROSE = "Make a copy of kamilborzecki.dev\n\nSame structure, same tone.";

function image(seed: string): ReferenceImage {
  const bytes = Buffer.from(seed, "utf8");
  return { path: `/tmp/refs/${seed}.png`, sha256: digestBytes(bytes), bytes: bytes.byteLength };
}

const CAPTURE: SiteCapture = {
  url: "https://kamilborzecki.dev/",
  capturedAt: "2026-07-30T12:00:00.000Z",
  shots: [
    { width: 1280, path: "/tmp/refs/capture-1280.png", sha256: "aa", bytes: 10 },
    { width: 375, path: "/tmp/refs/capture-375.png", sha256: "bb", bytes: 8 },
  ],
  outline: {
    url: "https://kamilborzecki.dev/",
    title: "Kamil Borzęcki",
    headings: [
      { level: 1, text: "Kamil Borzęcki" },
      { level: 2, text: "Selected work" },
      { level: 2, text: "Writing" },
    ],
    links: ["Home", "Work", "Contact"],
    palette: ["#111111", "#f5f5f5"],
  },
};

/* -------------------------------------------------------------------------
 * 1. Identity — the property that orphans suites when it breaks
 * ---------------------------------------------------------------------- */

test("a ticket with no references digests EXACTLY as it did before this module existed", () => {
  const before = ticketFromText(PROSE);
  const after = ticketWithReferences({ prose: PROSE, images: [], capture: null });

  assert.deepEqual(after, before, "all five fields, not just the id");
  /*
   * THE GOLDEN, AND WHY A LITERAL RATHER THAN A COMPARISON.
   *
   * `deepEqual` above only proves the two functions agree with EACH OTHER. If a
   * future edit changed `ticketIdFor` — a prefix, a slice length, a
   * normalisation — both sides would move together and that assertion would stay
   * green while every suite sealed under `dashboard/acceptance/<id>/` became
   * unaddressable. This literal is the raw sha256 of the exact bytes of `PROSE`,
   * computed outside this program with `openssl`-equivalent node crypto, so it
   * moves only if the digest itself is redefined.
   */
  assert.equal(
    after.id,
    "t-6bdfb7960f460ae1",
    "the id for a plain brief is frozen; a change here orphans every sealed suite on disk",
  );
  assert.equal(after.sha256, "6bdfb7960f460ae125d1722cd80727686e67283d1b610c26dca585542233fdfd");
});

test("an added reference image moves the id and NOTHING else", () => {
  const plain = ticketWithReferences({ prose: PROSE, images: [], capture: null });
  const withImage = ticketWithReferences({ prose: PROSE, images: [image("a")], capture: null });

  assert.notEqual(withImage.id, plain.id, "the owner's decision: same words + different reference = new ticket");
  assert.equal(withImage.brief, plain.brief, "the brief is the owner's words; an image adds no text to it");
  assert.equal(
    withImage.sha256,
    plain.sha256,
    "sha256 must stay the digest of the brief — spec-agent.ts:632 refuses a ticket where it is not",
  );
  assert.equal(withImage.title, plain.title);
});

test("two different reference sets are two different tickets, and order counts", () => {
  const one = ticketWithReferences({ prose: PROSE, images: [image("a")], capture: null });
  const two = ticketWithReferences({ prose: PROSE, images: [image("b")], capture: null });
  const both = ticketWithReferences({ prose: PROSE, images: [image("a"), image("b")], capture: null });
  const swapped = ticketWithReferences({ prose: PROSE, images: [image("b"), image("a")], capture: null });

  const ids = new Set([one.id, two.id, both.id, swapped.id]);
  assert.equal(ids.size, 4, "each distinct reference set gets its own frozen suite");
});

test("the same bytes at a different path are the SAME ticket", () => {
  const here = ticketWithReferences({
    prose: PROSE,
    images: [{ path: "/runs/a/references/reference-1.png", sha256: image("a").sha256, bytes: 1 }],
    capture: null,
  });
  const there = ticketWithReferences({
    prose: PROSE,
    images: [{ path: "/runs/zzz/references/reference-1.png", sha256: image("a").sha256, bytes: 1 }],
    capture: null,
  });
  // Identity is the CONTENT. A second run of the same brief writes its copies
  // into its own run directory, and it must reuse the first run's sealed suite
  // rather than paying to author an identical one.
  assert.equal(here.id, there.id);
});

test("a capture changes the brief, so it changes the sha256 and the id together", () => {
  const plain = ticketWithReferences({ prose: PROSE, images: [], capture: null });
  const captured = ticketWithReferences({ prose: PROSE, images: [], capture: CAPTURE });

  assert.notEqual(captured.brief, plain.brief);
  assert.notEqual(captured.sha256, plain.sha256);
  assert.notEqual(captured.id, plain.id);
  assert.equal(captured.title, plain.title, "the title is the owner's first line, never the captured page's");
});

test("identity material is the brief itself when there are no images", () => {
  // The mechanism behind the byte-identity property above, asserted directly so
  // a future edit that "tidies" the separator into an unconditional concatenation
  // fails here with a readable message instead of at the golden.
  assert.equal(referenceIdentityMaterial("brief", []), "brief");
  assert.notEqual(referenceIdentityMaterial("brief", [image("a")]), "brief");
});

/* -------------------------------------------------------------------------
 * 2. The wall: what the SPEC seat may and may not see
 * ---------------------------------------------------------------------- */

test("the brief NEVER mentions an image the spec seat cannot open", () => {
  const ticket = ticketWithReferences({
    prose: PROSE,
    images: [image("a"), image("b")],
    capture: CAPTURE,
  });

  const brief = ticket.brief;
  assert.ok(!brief.includes("/tmp/refs/a.png"), "no absolute path");
  assert.ok(!brief.includes("reference-1"), "no filename");
  assert.ok(!/\bimage\b/i.test(brief), "not even the fact that images exist");
  assert.ok(!brief.includes(image("a").sha256), "not the digest either");
  // The screenshots are files too, and the same rule applies to them.
  assert.ok(!brief.includes("capture-1280.png"), "no screenshot path");
});

test("the brief DOES carry the captured outline, in document order", () => {
  const brief = composeBrief(PROSE, CAPTURE);
  assert.ok(brief.startsWith(PROSE), "the owner's words come first and are untouched");
  assert.ok(brief.includes("Selected work"));
  assert.ok(brief.includes("Writing"));
  assert.ok(
    brief.indexOf("Selected work") < brief.indexOf("Writing"),
    "heading order is the only statement about layout this makes, so it must survive",
  );
  assert.ok(brief.includes("#111111"), "the palette reaches the seat that writes the criteria");
  assert.ok(brief.includes("https://kamilborzecki.dev/"));
  assert.ok(
    /partial|not complete/i.test(brief),
    "the block must not present itself to the spec seat as the whole page",
  );
});

test("an empty palette prints no palette line rather than claiming the site has no colours", () => {
  const brief = composeBrief(PROSE, { ...CAPTURE, outline: { ...CAPTURE.outline, palette: [] } });
  assert.ok(!/colours? declared/i.test(brief));
});

test("ticketProse recovers the owner's words, and is a no-op without a capture", () => {
  assert.equal(ticketProse(composeBrief(PROSE, CAPTURE)), PROSE);
  assert.equal(ticketProse(PROSE), PROSE, "a brief with no capture block is returned unchanged");
  assert.ok(composeBrief(PROSE, CAPTURE).includes(CAPTURE_BLOCK_BEGIN));
});

/* -------------------------------------------------------------------------
 * 3. The PATH half — build and design prompts
 * ---------------------------------------------------------------------- */

test("the builder section carries absolute paths AND the instruction to open them", () => {
  const section = builderReferenceSection({ images: [image("a")], capture: CAPTURE });
  assert.ok(section.includes("/tmp/refs/a.png"));
  assert.ok(section.includes("/tmp/refs/capture-1280.png"));
  assert.ok(section.includes("/tmp/refs/capture-375.png"));
  // The mechanism, not decoration: a path with no instruction produces a run
  // that acknowledges an attachment it never read. Same rule as the chat images.
  assert.equal(
    (section.match(/READ EACH ONE BEFORE ACTING/g) ?? []).length,
    2,
    "once for the capture, once for the uploads — a shared sentence at the bottom is skippable",
  );
});

test("the design section tells the lane the target already exists", () => {
  const section = designReferenceSection({ images: [], capture: CAPTURE });
  assert.ok(section.includes("https://kamilborzecki.dev/"));
  assert.ok(section.includes("/tmp/refs/capture-1280.png"));
  assert.ok(/already exists/i.test(section));
});

test("nothing to show renders the empty string, so the call sites need no `if`", () => {
  assert.equal(builderReferenceSection(null), "");
  assert.equal(builderReferenceSection({ images: [], capture: null }), "");
  assert.equal(designReferenceSection(null), "");
  assert.equal(designReferenceSection({ images: [], capture: null }), "");
  // A capture that produced NO screenshots is nothing to show either — the
  // outline already reached the brief, and a heading with no paths under it is a
  // section that tells the builder to read a list of nothing.
  assert.equal(builderReferenceSection({ images: [], capture: { ...CAPTURE, shots: [] } }), "");
  assert.equal(hasReferences({ images: [], capture: { ...CAPTURE, shots: [] } }), false);

  // AND THE MIXED CASE, which `hasReferences` alone does not cover: images
  // exist, so the section renders — but a capture with no pictures must not
  // print "READ EACH ONE BEFORE ACTING" above an empty list.
  const mixed = builderReferenceSection({ images: [image("a")], capture: { ...CAPTURE, shots: [] } });
  assert.ok(mixed.includes("/tmp/refs/a.png"));
  assert.ok(!mixed.includes("kamilborzecki.dev"), "no capture block when the capture has no pictures");
  assert.equal((mixed.match(/READ EACH ONE BEFORE ACTING/g) ?? []).length, 1);
});

test("the read-back path rebuilds the SAME ticket the intake minted", () => {
  // THE PROPERTY THE ORCHESTRATOR DEPENDS ON. It holds `row.ticketText` (the
  // composed brief) and the manifest's image list, and must arrive at the id the
  // intake wrote — otherwise the run authors a second suite under a name nobody
  // can see is wrong.
  const images = [image("a"), image("b")];
  const minted = ticketWithReferences({ prose: PROSE, images, capture: CAPTURE });
  const rebuilt = ticketFromStoredBrief(minted.brief, images);
  assert.deepEqual(rebuilt, minted);

  // AND THE FAILURE IT IS EXPOSED TO: a lost manifest silently produces a
  // DIFFERENT ticket. That is why the orchestrator compares the two and says so.
  assert.notEqual(ticketFromStoredBrief(minted.brief, []).id, minted.id);

  // A prose that ends in blank lines is the case that killed the alternative
  // design (strip the block back off and re-compose): `ticketProse` cannot
  // return trailing newlines, so a round trip through it is lossy. The read-back
  // path does not do that, and this pins the difference.
  const padded = ticketWithReferences({ prose: "Copy it\n\n", images: [], capture: CAPTURE });
  assert.deepEqual(ticketFromStoredBrief(padded.brief, []), padded);
  assert.notEqual(ticketProse(padded.brief), "Copy it\n\n", "the lossy inverse, demonstrated rather than assumed");
});

/* -------------------------------------------------------------------------
 * 4. Intake decoding — the caps, and the refusals
 * ---------------------------------------------------------------------- */

test("decodeReferenceDataUrl accepts the four types and refuses everything else", () => {
  const png = Buffer.from("not really a png").toString("base64");
  assert.equal(decodeReferenceDataUrl(`data:image/png;base64,${png}`)?.ext, "png");
  assert.equal(decodeReferenceDataUrl(`data:image/jpeg;base64,${png}`)?.ext, "jpg", "jpeg normalises to jpg");
  assert.equal(decodeReferenceDataUrl(`data:image/webp;base64,${png}`)?.ext, "webp");
  assert.equal(decodeReferenceDataUrl(`data:image/gif;base64,${png}`)?.ext, "gif");

  assert.equal(decodeReferenceDataUrl(`data:image/svg+xml;base64,${png}`), null, "svg is script-bearing markup");
  assert.equal(decodeReferenceDataUrl("data:text/html;base64,PGgxPmhpPC9oMT4="), null);
  assert.equal(decodeReferenceDataUrl("https://example.com/x.png"), null, "a URL is not bytes we hold");
  assert.equal(decodeReferenceDataUrl(42), null);
  assert.equal(decodeReferenceDataUrl(undefined), null);
  assert.equal(decodeReferenceDataUrl("data:image/png;base64,"), null, "an empty image is not an image");
});

test("an oversized image is refused BY SIZE, not truncated", () => {
  // The failure this watches: a cap that is checked against the base64 LENGTH
  // rather than the decoded byte count lets through ~33% more than it claims.
  const tooBig = Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1, 7).toString("base64");
  assert.equal(decodeReferenceDataUrl(`data:image/png;base64,${tooBig}`), null);

  const justUnder = Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES - 1, 7).toString("base64");
  const decoded = decodeReferenceDataUrl(`data:image/png;base64,${justUnder}`);
  assert.equal(decoded?.bytes.byteLength, MAX_REFERENCE_IMAGE_BYTES - 1, "the cap is on the decoded bytes");
});

test("the caps are the chat's caps", () => {
  assert.equal(MAX_REFERENCE_IMAGES, 6);
  assert.equal(MAX_REFERENCE_IMAGE_BYTES, 8 * 1024 * 1024);
});

/* -------------------------------------------------------------------------
 * 5. The manifest — including every way reading it fails
 * ---------------------------------------------------------------------- */

test("the manifest round-trips, and every unreadable form comes back null", () => {
  const root = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    const dir = referenceDirFor(root, "run-2026-07-30-abcd");
    assert.ok(dir.endsWith("/references"));
    assert.equal(readReferenceManifest(dir), null, "absent directory reads as null, not as a throw");

    // `writeReferenceManifest` deliberately does not create its own directory:
    // `http.ts` creates it before writing the image bytes, and a second
    // `mkdirSync` inside the writer would hide the case where a manifest is
    // written somewhere the images are not.
    mkdirSync(dir, { recursive: true });
    assert.equal(readReferenceManifest(dir), null, "absent file reads as null");

    writeReferenceManifest(dir, { images: [image("a")], capture: CAPTURE });
    const back = readReferenceManifest(dir);
    assert.equal(back?.images.length, 1);
    assert.equal(back?.capture?.shots.length, 2);
    assert.equal(back?.capture?.outline.headings[1]?.text, "Selected work");

    writeFileSync(join(dir, "references.json"), "{ this is not json", "utf8");
    assert.equal(readReferenceManifest(dir), null, "corrupt reads as null — the build degrades, it does not die");

    writeFileSync(join(dir, "references.json"), '{"capture":null}', "utf8");
    assert.equal(readReferenceManifest(dir), null, "a manifest with no images array is not a manifest");

    // THE DISTINCTION THAT IS KEPT: "read it, there is nothing in it" is not
    // "could not read it". Only the first is a manifest.
    writeReferenceManifest(dir, { images: [], capture: null });
    // `documents` NORMALISES TO `[]`, NOT TO ABSENT — the same rule this test is
    // about, applied to the field that arrived after it was written. A manifest
    // recorded before documents existed carries no `documents` key, and it must
    // read back as "there are none" rather than as unreadable; anything else
    // would make every pre-document run look corrupt.
    assert.deepEqual(readReferenceManifest(dir), { images: [], capture: null, documents: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run id that is not a safe path segment cannot walk out of the runs directory", () => {
  const dir = referenceDirFor("/var/dash/runs", "../../etc");
  // `safeSegment` MANGLES RATHER THAN REJECTS, so the id becomes `.._.._etc` —
  // a literal `..` still appears in the string and that is fine. The property
  // that matters is that `resolve` cannot leave the runs root, which a substring
  // check does not test: `/var/dash/runs/.._.._etc` resolves to itself.
  assert.equal(resolve(dir), resolve("/var/dash/runs", ".._.._etc", "references"));
  assert.ok(resolve(dir).startsWith("/var/dash/runs/"), dir);
});
