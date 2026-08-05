/**
 * owner-reference.test.ts — the second slot, and the fence around it.
 *
 * TWO OF THESE TESTS RUN AGAINST THE REAL RUNS ON DISK rather than a fixture,
 * and that is the point of the file. The 2026-08-04 run is the ONLY run in this
 * project's history where the owner attached an image (`reference-1.png`, 1024×559,
 * 559,692 bytes, digest `56c0c61c…`), and the 2026-07-30 run is the only one that
 * took the `capture` branch instead. A reader that returns the first and refuses
 * the second is the whole behaviour; a reader calibrated only against fixtures
 * would be a reader calibrated against my own imagination of what those files
 * look like. They are read-only and never modified here.
 *
 * THE SECURITY HALF IS THE LONGER HALF, and it is not proportionate to the
 * threat as the sandbox stands today — `references/` is host-written and outside
 * `allowWrite`. It is proportionate to what the value IS: an absolute path this
 * module vouches for, handed to an agent to open on the strength of that
 * vouching. The module next door (`design-manifest.ts`) states the rule this one
 * inherits: an unvalidated path there is a file-read primitive with a prompt
 * attached.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ownerReferenceFor, ownerReferencesFor } from "./owner-reference.js";

/** The repo's own `dashboard/runs`, from this test file's compiled location. */
const REAL_RUNS = join(dirname(new URL(import.meta.url).pathname), "..", "..", "runs");

/** The one run in this project's history that carries an owner-attached image. */
const RUN_WITH_IMAGE = "run-2026-08-04T11-08-10-487Z-162b186d";
/** The run whose `references.json` opens `"images": []` and carries a site CAPTURE. */
const RUN_WITH_CAPTURE = "run-2026-07-30T20-16-40-242Z-052c6e02";
/** The one build that ever passed — and it has no `references/` directory at all. */
const RUN_WITH_NOTHING = "run-2026-07-29T23-28-46-665Z-3d4d1ccb";

/* ---- the real artefacts ------------------------------------------------ */

test("REAL RUN: the owner's attached image is found, by path and by digest", (t) => {
  if (!existsSync(join(REAL_RUNS, RUN_WITH_IMAGE))) {
    t.skip(`${RUN_WITH_IMAGE} is not on this machine`);
    return;
  }
  const reference = ownerReferenceFor(REAL_RUNS, RUN_WITH_IMAGE);
  assert.notEqual(reference, null, "the one run that attached a design must resolve one");
  assert.equal(reference?.sha256, "56c0c61c4e960bfe707284581827b7d074ad946dd0ec7d7f6f4bfe5f04b3cfe3");
  assert.equal(reference?.bytes, 559_692);
  assert.match(reference?.path ?? "", /references\/reference-1\.png$/u);
  assert.ok(existsSync(reference?.path ?? ""), "the path is one an agent can actually open");
});

test("REAL RUN: a site CAPTURE is not a supplied design", (t) => {
  // 2026-07-30 named a URL and this program screenshotted it. That is a
  // reference in the loose sense and is emphatically not "the design I
  // provided" — handing the grader a screenshot of an existing site as the
  // thing the build was meant to reproduce is a false referent, and this is the
  // one run on disk where it would have been produced.
  if (!existsSync(join(REAL_RUNS, RUN_WITH_CAPTURE))) {
    t.skip(`${RUN_WITH_CAPTURE} is not on this machine`);
    return;
  }
  assert.equal(ownerReferenceFor(REAL_RUNS, RUN_WITH_CAPTURE), null);
  assert.equal(ownerReferencesFor(REAL_RUNS, RUN_WITH_CAPTURE).length, 0);
});

test("REAL RUN: a run with no references directory reads as none, not as an error", (t) => {
  if (!existsSync(join(REAL_RUNS, RUN_WITH_NOTHING))) {
    t.skip(`${RUN_WITH_NOTHING} is not on this machine`);
    return;
  }
  // The DESIGN lane degrades rather than blocks; so does this.
  assert.equal(ownerReferenceFor(REAL_RUNS, RUN_WITH_NOTHING), null);
});

/* ---- the fence --------------------------------------------------------- */

interface Harness {
  readonly runs: string;
  readonly runId: string;
  readonly references: string;
  /** Writes bytes somewhere and returns `{path, sha256, bytes}` for a manifest. */
  readonly place: (relative: string, body: string) => { path: string; sha256: string; bytes: number };
  readonly manifest: (images: readonly unknown[]) => void;
}

function harness(): Harness {
  const runs = mkdtempSync(join(tmpdir(), "owner-ref-"));
  const runId = "run-test";
  const references = join(runs, runId, "references");
  mkdirSync(references, { recursive: true });
  return {
    runs,
    runId,
    references,
    place: (relative, body) => {
      const path = join(runs, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return { path, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
    },
    manifest: (images) => {
      writeFileSync(join(references, "references.json"), JSON.stringify({ images, capture: null }), "utf8");
    },
  };
}

test("a valid entry in the run's OWN references directory is accepted", () => {
  const h = harness();
  const image = h.place(`${h.runId}/references/reference-1.png`, "not really a png, but the bytes are the bytes");
  h.manifest([image]);
  // THE MUST-PASS HALF. Every refusal below is worthless if the reader refuses
  // everything — a fence that admits nothing sorts every hostile case correctly
  // and is indistinguishable from `return null`.
  const reference = ownerReferenceFor(h.runs, h.runId);
  assert.equal(reference?.path, image.path);
  assert.equal(reference?.sha256, image.sha256);
});

test("a path OUTSIDE this run's references directory is refused, in every shape", () => {
  const h = harness();
  const cases: readonly { readonly name: string; readonly relative: string }[] = [
    // The workspace — where a build can write, reached by traversal.
    { name: "traversal into the workspace", relative: `${h.runId}/workspace/index.html.png` },
    // A SIBLING WHOSE NAME BEGINS WITH THE FENCE'S. This is the case a
    // `startsWith(dir)` prefix test admits and directory equality refuses.
    { name: "prefix sibling", relative: `${h.runId}/references-elsewhere/reference-1.png` },
    // A SUBDIRECTORY. The intake writes flat; nothing legitimate is nested.
    { name: "subdirectory", relative: `${h.runId}/references/nested/reference-1.png` },
    // ANOTHER RUN'S references — a real directory, correctly named, wrong run.
    { name: "another run", relative: `run-other/references/reference-1.png` },
  ];
  for (const { name, relative } of cases) {
    const image = h.place(relative, `bytes for ${name}`);
    h.manifest([image]);
    assert.equal(ownerReferenceFor(h.runs, h.runId), null, `${name} must be refused`);
  }
  // AND THE SPELLING, not just the resolved location: `references/../workspace`
  // resolves out of the fence and must be compared as what it names.
  const escaped = h.place(`${h.runId}/workspace/hero.png`, "escaped");
  h.manifest([{ ...escaped, path: join(h.references, "..", "workspace", "hero.png") }]);
  assert.equal(ownerReferenceFor(h.runs, h.runId), null, "a path that SPELLS the fence but names outside it");
});

test("a file that is not an image is refused, even inside the fence", () => {
  const h = harness();
  // `references.json` itself lives here, and `documents/` next door holds bytes
  // `document-intake.ts` says cannot be redacted. Neither belongs in front of a
  // vision grader as "the design the owner supplied".
  for (const relative of [`${h.runId}/references/references.json`, `${h.runId}/references/brief.pdf`]) {
    const file = h.place(relative, "{}");
    h.manifest([file]);
    assert.equal(ownerReferenceFor(h.runs, h.runId), null, `${relative} must be refused`);
  }
});

test("bytes that no longer match the recorded digest are refused", () => {
  const h = harness();
  const image = h.place(`${h.runId}/references/reference-1.png`, "the original bytes");
  h.manifest([{ ...image, sha256: createHash("sha256").update("some other design entirely").digest("hex") }]);
  // The digest is what enters the TICKET ID, and the run is graded under that
  // ticket. A reference whose bytes drifted from it is not the design this run
  // was minted from, and grading against it would read as evidence.
  assert.equal(ownerReferenceFor(h.runs, h.runId), null);
  // A malformed digest is refused before anything is opened.
  h.manifest([{ ...image, sha256: "not-a-digest" }]);
  assert.equal(ownerReferenceFor(h.runs, h.runId), null);
});

test("a manifest entry naming a file that does not exist is refused", () => {
  const h = harness();
  h.manifest([{ path: join(h.references, "reference-9.png"), sha256: "0".repeat(64), bytes: 1 }]);
  assert.equal(ownerReferenceFor(h.runs, h.runId), null);
});

test("a corrupt or shapeless manifest degrades to none rather than throwing", () => {
  const h = harness();
  writeFileSync(join(h.references, "references.json"), "{ not json", "utf8");
  assert.deepEqual(ownerReferencesFor(h.runs, h.runId), []);
  h.manifest([null, 7, "a string", { path: 12, sha256: "0".repeat(64) }, {}]);
  assert.deepEqual(ownerReferencesFor(h.runs, h.runId), []);
});

test("ONE reference is compared against, and it is the FIRST he attached", () => {
  const h = harness();
  const first = h.place(`${h.runId}/references/reference-1.png`, "the one his prose is about");
  const second = h.place(`${h.runId}/references/reference-2.webp`, "a second angle");
  h.manifest([first, second]);
  assert.equal(ownerReferencesFor(h.runs, h.runId).length, 2, "both are still recorded");
  // Comparing a design against a SET answers "does this resemble something he
  // sent us", which is the vague question the lock exists to replace.
  assert.equal(ownerReferenceFor(h.runs, h.runId)?.path, first.path);
});

test("one bad entry does not discard the good ones beside it", () => {
  const h = harness();
  const good = h.place(`${h.runId}/references/reference-2.png`, "valid");
  h.manifest([{ path: "/etc/passwd", sha256: "0".repeat(64), bytes: 1 }, good]);
  // A single unvouchable entry must not take a legitimate attachment down with
  // it — the run would then grade with no owner reference for a reason nobody
  // could see in the record.
  assert.deepEqual(
    ownerReferencesFor(h.runs, h.runId).map((image) => image.path),
    [good.path],
  );
});
