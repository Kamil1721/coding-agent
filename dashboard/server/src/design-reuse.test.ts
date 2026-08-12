/**
 * design-reuse.test.ts — the four refusals, the copy, and the ONE rewrite the
 * whole feature stands on.
 *
 * ─── WHAT IS BEING PROTECTED ───
 *
 * `parseDesignManifest` fences `refs[].path` to `<workspace>/design-refs/` and
 * honours `locked` only when it equals a ref path by EXACT STRING EQUALITY. So a
 * copy that forgets to rewrite paths does not produce a run pointing at another
 * run's files — it produces something quieter and worse:
 *
 *   refs not rewritten → `readRef` returns null → the manifest is NULL. No design
 *                        at all, on a run whose record says it reused one.
 *   lock not rewritten → `lockedMockup: null`. The build gets the stills and the
 *                        VISUAL GATE silently falls back to rule-based scoring.
 *
 * Neither throws. Both are asserted below, by construction, in
 * "THE TWO SILENT FAILURE MODES" — which is what makes the positive assertions
 * elsewhere in this file mean something.
 *
 * ─── EVERY REFUSAL CARRIES ITS OWN NEGATIVE CONTROL ───
 *
 * Each refusal test breaks ONE thing on a copy of a source that is otherwise
 * complete, and asserts in the same test that the UNBROKEN source is accepted. A
 * validator that refused everything would satisfy four assertions and fail all
 * four controls.
 *
 * ─── THE FIXTURE'S NUMBERS ARE THE MEASURED ONES ───
 *
 * Three directions, seven stills for the locked one and two for each of the
 * others: 11 images. That is tonight's `results/design-lane.json` from
 * `run-2026-08-12T09-00-35-066Z-6ec44b2f` — `"images": 11, "imageCalls": 5` —
 * and the shape on disk in its `design-refs/` (`desk-scatter-01-hero.png` …
 * `-07-selected-work.png`, plus two stills each for `margin-annotation` and
 * `ruled-ledger`).
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeDesignLock, emptyDesignLockRecord } from "./design-lock.js";
import {
  DESIGN_MANIFEST_FILE,
  manifestPathFor,
  readDesignManifest,
  refsDirFor,
  serialiseDesignManifest,
} from "./design-manifest.js";
import { FIXTURE_IMAGE_COUNT, FIXTURE_LOCKED_AT, writeReusableDesign } from "./design-reuse-fixture.js";
import {
  DESIGN_REUSE_MARKER_FILE,
  copyDesignAssets,
  readDesignReuseMarker,
  validateDesignReuseSource,
  writeDesignReuseMarker,
} from "./design-reuse.js";
import type { RunPaths } from "./paths.js";
import { runPathsFor } from "./paths.js";
import { resolvePaths } from "./paths.js";

interface Fixture {
  readonly root: string;
  readonly paths: ReturnType<typeof resolvePaths>;
  readonly source: RunPaths;
  readonly sourceRunId: string;
  readonly dest: RunPaths;
  cleanup(): void;
}

/** The shared fixture, in its own temp dashboard home. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "design-reuse-"));
  const paths = resolvePaths({ DASHBOARD_HOME: root });
  const sourceRunId = "run-2026-08-12T09-00-35-066Z-6ec44b2f";
  const source = runPathsFor(paths, sourceRunId);
  const dest = runPathsFor(paths, "run-2026-08-12T21-00-00-000Z-deadbeef");
  writeReusableDesign(source);

  return {
    root,
    paths,
    source,
    sourceRunId,
    dest,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function check(f: Fixture): ReturnType<typeof validateDesignReuseSource> {
  return validateDesignReuseSource(f.sourceRunId, f.source);
}

/* ---- the fixture is what the measurement says it is -------------------- */

test("the fixture is the measured shape: 11 stills over 3 directions, one locked", () => {
  const f = fixture();
  try {
    const result = check(f);
    assert.ok(result.ok, `the complete source must be accepted, got ${JSON.stringify(result)}`);
    assert.equal(FIXTURE_IMAGE_COUNT, 11, "tonight's run wrote 11 images; the fixture must be that run's shape");
    assert.equal(result.source.images, FIXTURE_IMAGE_COUNT, "counted from disk, by content, not from the manifest");
    assert.equal(result.source.manifest.directions.length, 3);
    assert.equal(result.source.locked, join(refsDirFor(f.source.workspace), "desk-scatter-01-hero.png"));
  } finally {
    f.cleanup();
  }
});

/* ---- the four refusals, each with its own negative control ------------- */

test("REFUSAL: a source run that is not on disk — and the real one is still accepted", () => {
  const f = fixture();
  try {
    const absent = validateDesignReuseSource("run-nobody-ever-made", runPathsFor(f.paths, "run-nobody-ever-made"));
    assert.equal(absent.ok, false);
    assert.equal(absent.ok === false ? absent.code : null, "reuse_source_missing");
    // THE CONTROL. Without this line a validator that refuses every id passes.
    assert.equal(check(f).ok, true, "the complete source must still be accepted by the same call");
  } finally {
    f.cleanup();
  }
});

test("REFUSAL: a source run with no design-refs directory — the lane was off or degraded", () => {
  const f = fixture();
  try {
    assert.equal(check(f).ok, true, "the control: it was accepted before the directory was removed");
    rmSync(refsDirFor(f.source.workspace), { recursive: true, force: true });
    const result = check(f);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : null, "reuse_source_no_design_refs");
  } finally {
    f.cleanup();
  }
});

test("REFUSAL: a design-refs directory with no manifest.json, and one that will not parse", () => {
  const f = fixture();
  try {
    assert.equal(check(f).ok, true, "the control");
    const manifestPath = manifestPathFor(f.source.workspace);
    const good = readFileSync(manifestPath, "utf8");

    rmSync(manifestPath);
    const absent = check(f);
    assert.equal(absent.ok, false);
    assert.equal(absent.ok === false ? absent.code : null, "reuse_source_no_manifest");
    assert.match(
      absent.ok === false ? absent.message : "",
      /no manifest\.json/,
      "an absent manifest must not be reported in the words of an unreadable one",
    );

    // PRESENT AND UNREADABLE IS THE SAME REFUSAL AND A DIFFERENT SENTENCE. A
    // caller told "no manifest.json" while the file is sitting there goes looking
    // in the wrong place.
    writeFileSync(manifestPath, "{ this is not json", "utf8");
    const unparseable = check(f);
    assert.equal(unparseable.ok, false);
    assert.equal(unparseable.ok === false ? unparseable.code : null, "reuse_source_no_manifest");
    assert.match(unparseable.ok === false ? unparseable.message : "", /did not parse/);

    writeFileSync(manifestPath, good, "utf8");
    assert.equal(check(f).ok, true, "the control, restored: the refusal was the manifest and nothing else");
  } finally {
    f.cleanup();
  }
});

test("REFUSAL: a source that locked nothing — in the manifest, in the record, or on disk", () => {
  const f = fixture();
  try {
    assert.equal(check(f).ok, true, "the control");
    const manifestPath = manifestPathFor(f.source.workspace);
    const complete = readDesignManifest(f.source.workspace);
    assert.ok(complete !== null);

    // 1. THE MANIFEST NEVER LOCKED A STILL. This is a run parked awaiting a
    //    choice, or a degraded run that had nothing to lock.
    writeFileSync(
      manifestPath,
      serialiseDesignManifest({ ...complete, lockedMockup: null, lockedBy: null, lockedReason: null }),
      "utf8",
    );
    const noManifestLock = check(f);
    assert.equal(noManifestLock.ok, false);
    assert.equal(noManifestLock.ok === false ? noManifestLock.code : null, "reuse_source_no_lock");
    writeFileSync(manifestPath, serialiseDesignManifest(complete), "utf8");
    assert.equal(check(f).ok, true, "the control, restored");

    // 2. THE RECORD HAS NO LOCK. §17.3 rule 5 makes the lock a recorded INPUT to
    //    the gate; a manifest claiming one that no record accounts for is a design
    //    that was never settled by the host.
    rmSync(join(f.source.results, "design-lock.json"));
    const noRecord = check(f);
    assert.equal(noRecord.ok, false);
    assert.equal(noRecord.ok === false ? noRecord.code : null, "reuse_source_no_lock");
    writeDesignLock(f.source.results, {
      ...emptyDesignLockRecord(FIXTURE_LOCKED_AT),
      locked: complete.lockedMockup,
      expanded: true,
    });
    assert.equal(check(f).ok, true, "the control, restored");

    // 3. THE LOCKED FILE IS GONE. This one passes every null check and is the
    //    reason the check reaches disk at all: the copy would land without that
    //    PNG, `pruneMissingRefs` would drop the lock out of the handoff, and the
    //    gate would grade on the rule-based floor while the record claimed a
    //    locked design.
    rmSync(String(complete.lockedMockup));
    const gone = check(f);
    assert.equal(gone.ok, false);
    assert.equal(gone.ok === false ? gone.code : null, "reuse_source_no_lock");
    assert.match(gone.ok === false ? gone.message : "", /not on disk/);
  } finally {
    f.cleanup();
  }
});

test("the source run's STATUS is never consulted — there is no status to consult", () => {
  // Stated as a test because it is the assumption the whole check rests on: this
  // function is handed a run id and a directory, and there is no store, no row and
  // no `completed` flag anywhere in its signature. A `completed` run whose lane
  // was degraded has no stills, and one whose image chain died has a manifest
  // listing refs nobody wrote.
  const f = fixture();
  try {
    assert.equal(validateDesignReuseSource.length, 2, "runId and RunPaths — nothing that could carry a status");
    assert.equal(check(f).ok, true);
  } finally {
    f.cleanup();
  }
});

/* ---- the copy ---------------------------------------------------------- */

test("the copy takes every file in design-refs/ and NOTHING else from the source run", () => {
  const f = fixture();
  try {
    const source = check(f);
    assert.ok(source.ok);
    mkdirSync(f.dest.workspace, { recursive: true });
    const copied = copyDesignAssets(source.source, f.dest);
    assert.ok(copied.ok, `the copy must succeed: ${JSON.stringify(copied)}`);

    const sourceNames = readdirSync(refsDirFor(f.source.workspace)).sort();
    const destNames = readdirSync(refsDirFor(f.dest.workspace)).sort();
    assert.deepEqual(destNames, sourceNames, "every file in design-refs/ crosses, and only those");
    assert.equal(copied.images, FIXTURE_IMAGE_COUNT, "the eleven stills the source measured");
    assert.equal(copied.files, sourceNames.length);

    // THE EXCLUSIONS, ASSERTED RATHER THAN ASSUMED. The source's own code and its
    // own results are what a reuse must never carry: they are another run's
    // artefact and another run's record.
    assert.equal(existsSync(join(f.dest.workspace, "src")), false, "the source's src/ must not be copied");
    assert.equal(existsSync(join(f.dest.results, "score.json")), false, "the source's results/ must not be copied");
    assert.equal(
      existsSync(join(f.dest.root, ".design-reuse-staging")),
      false,
      "the staging directory must not survive the copy",
    );
  } finally {
    f.cleanup();
  }
});

test("THE LOCK POINTS AT THIS RUN'S OWN COPY — asserted by path, on both records", () => {
  const f = fixture();
  try {
    const source = check(f);
    assert.ok(source.ok);
    mkdirSync(f.dest.workspace, { recursive: true });
    const copied = copyDesignAssets(source.source, f.dest);
    assert.ok(copied.ok);

    const destRefs = refsDirFor(f.dest.workspace);
    // READ BACK THROUGH THE ONE READ PATH every consumer uses, against the NEW
    // workspace. A manifest that survives this has paths the fence accepts.
    const manifest = readDesignManifest(f.dest.workspace);
    assert.ok(manifest !== null, "the copied manifest must parse against the destination workspace");
    assert.notEqual(
      manifest.lockedMockup,
      null,
      "the lock must survive the rewrite — parseDesignManifest honours `locked` only on EXACT equality " +
        "with a ref path, so a rewritten refs list with an un-rewritten lock reads as no lock at all",
    );
    assert.ok(
      String(manifest.lockedMockup).startsWith(destRefs),
      `the lock must be inside ${destRefs}, got ${String(manifest.lockedMockup)}`,
    );
    assert.equal(existsSync(String(manifest.lockedMockup)), true, "and the file it names must be on disk");

    for (const ref of manifest.refs) {
      assert.ok(ref.path.startsWith(destRefs), `ref ${ref.path} is not inside this run's workspace`);
      assert.equal(existsSync(ref.path), true, `ref ${ref.path} names a file that is not there`);
    }
    for (const direction of manifest.directions) {
      assert.notEqual(direction.notes, null, "a notes path that fell outside the fence would read as null");
      assert.ok(String(direction.notes).startsWith(destRefs), `notes ${String(direction.notes)} escaped the copy`);
    }
    // NOT ONE STRING ANYWHERE IN THE FILE NAMES THE SOURCE RUN. The `startsWith`
    // assertions above can be satisfied field by field; this one cannot be
    // satisfied by a field somebody forgets to rewrite.
    const onDisk = readFileSync(manifestPathFor(f.dest.workspace), "utf8");
    assert.equal(
      onDisk.includes(f.sourceRunId),
      false,
      "the copied manifest still contains the SOURCE run id: some path was not rewritten",
    );

    // AND THE SOURCE IS UNTOUCHED. A rewrite that mutated the original would
    // break the run that lent its design — and every later reuse of it.
    const sourceManifest = readDesignManifest(f.source.workspace);
    assert.ok(sourceManifest?.lockedMockup?.startsWith(refsDirFor(f.source.workspace)) === true);
  } finally {
    f.cleanup();
  }
});

test("THE TWO SILENT FAILURE MODES — the copy's read-back is what stands in front of them", () => {
  const f = fixture();
  try {
    const source = check(f);
    assert.ok(source.ok);
    mkdirSync(f.dest.workspace, { recursive: true });
    const copied = copyDesignAssets(source.source, f.dest);
    assert.ok(copied.ok);
    const destWorkspace = f.dest.workspace;
    const good = readDesignManifest(destWorkspace);
    assert.ok(good !== null);

    /*
     * MODE 1 — THE PATHS ARE NOT REWRITTEN AT ALL. This is the manifest a naive
     * `copyFileSync(manifest.json)` leaves behind. It does not point at the source
     * run's files: `readRef` refuses every ref whose path is outside THIS
     * workspace's refs directory, and one refused ref is a null MANIFEST.
     */
    writeFileSync(manifestPathFor(destWorkspace), serialiseDesignManifest(source.source.manifest), "utf8");
    assert.equal(
      readDesignManifest(destWorkspace),
      null,
      "an un-rewritten manifest must read as NO manifest — if this ever parses, the fence is gone and a " +
        "run really can be handed another run's files",
    );

    /*
     * MODE 2 — THE REFS ARE REWRITTEN AND THE LOCK IS NOT. This is the shape the
     * lock-rewrite mutation produces, and it is the quiet one: the build gets
     * every still and the VISUAL GATE gets no reference, so it falls back to
     * rule-based scoring on a run whose record claims a locked design.
     */
    writeFileSync(
      manifestPathFor(destWorkspace),
      serialiseDesignManifest({ ...good, lockedMockup: source.source.locked }),
      "utf8",
    );
    const halfRewritten = readDesignManifest(destWorkspace);
    assert.ok(halfRewritten !== null, "the refs are fine, so the manifest still parses");
    assert.equal(
      halfRewritten.lockedMockup,
      null,
      "a lock naming the SOURCE's path must read as no lock — this is the exact-string-equality rule in " +
        "parseDesignManifest, and it is why the lock rewrite cannot be skipped",
    );
    assert.notEqual(good.lockedMockup, null, "the control: the correctly-rewritten manifest DID carry a lock");
  } finally {
    f.cleanup();
  }
});

test("THE VIDEO MARKS DO NOT CROSS — a reused run must not buy motion for art it did not make", () => {
  /*
   * MEASURED ON THE REAL SOURCE: `grep -c '"animate": true'` over
   * `run-2026-08-12T09-00-35-066Z-6ec44b2f/workspace/design-refs/manifest.json`
   * returns 2, and the fixture carries the same two.
   *
   * WHY IT MATTERS HERE AND NOWHERE ELSE. `runVideoLane` is gated on
   * `!designSegment`, and a reused run's FIRST AND ONLY segment is the build one —
   * so the video lane executes on it, `planVideoLegs` reads the marked refs, and
   * each one is a metered Veo leg. A run that reused a design precisely in order to
   * spend nothing would have bought video for somebody else's stills.
   */
  const f = fixture();
  try {
    const source = check(f);
    assert.ok(source.ok);
    const marked = source.source.manifest.refs.filter((ref) => ref.animate === true);
    assert.equal(marked.length, 2, "the fixture must carry the measured number of marks, or this proves nothing");

    mkdirSync(f.dest.workspace, { recursive: true });
    const copied = copyDesignAssets(source.source, f.dest);
    assert.ok(copied.ok);
    assert.equal(copied.videoMarksDropped, 2, "the copy reports what it dropped rather than dropping it silently");

    const manifest = readDesignManifest(f.dest.workspace);
    assert.equal(
      manifest?.refs.filter((ref) => ref.animate === true).length,
      0,
      "an inherited animate mark is a metered Veo leg on the reusing run's own build segment",
    );
    // OMITTED, NOT `false`. `DesignRef.animate` says absent means "2b never
    // considered it"; writing `false` would invent a decision nobody made.
    assert.equal(
      readFileSync(manifestPathFor(f.dest.workspace), "utf8").includes("animate"),
      false,
      "the key is dropped rather than set to false",
    );
    // THE CONTROL: the source keeps its own marks. This is a copy, not a migration.
    assert.equal(readDesignManifest(f.source.workspace)?.refs.filter((r) => r.animate === true).length, 2);
  } finally {
    f.cleanup();
  }
});

test("a copy whose set does not survive the read-back is refused WHOLE, leaving no half-design", () => {
  const f = fixture();
  try {
    const source = check(f);
    assert.ok(source.ok);
    mkdirSync(f.dest.workspace, { recursive: true });
    // A source whose locked still is deleted between the validation and the copy —
    // the race the intake check cannot close. The copy must not leave a partial
    // set behind: half a direction is worse than none.
    rmSync(source.source.locked);
    const copied = copyDesignAssets(source.source, f.dest);
    assert.equal(copied.ok, false, "a set whose lock names a missing file is not a usable design");
    assert.equal(
      existsSync(refsDirFor(f.dest.workspace)),
      false,
      "the refused copy must leave NO design-refs directory — a partial set puts the builder in front of " +
        "Read targets that resolve to nothing",
    );
  } finally {
    f.cleanup();
  }
});

/* ---- the marker -------------------------------------------------------- */

test("the marker round-trips, and it is written OUTSIDE the workspace a build can write to", () => {
  const f = fixture();
  try {
    writeDesignReuseMarker(f.dest.root, { sourceRunId: f.sourceRunId, requestedAt: "2026-08-12T21:00:00.000Z" });
    const read = readDesignReuseMarker(f.dest.root);
    assert.equal(read?.sourceRunId, f.sourceRunId);
    assert.equal(existsSync(join(f.dest.root, DESIGN_REUSE_MARKER_FILE)), true);
    assert.equal(
      existsSync(join(f.dest.workspace, DESIGN_REUSE_MARKER_FILE)),
      false,
      "the marker must not be inside the workspace: that is the one directory a build agent may write to, " +
        "and a forgeable marker is a build choosing which run's design it inherits",
    );
    assert.equal(readDesignReuseMarker(join(f.root, "no-such-run")), null, "an absent marker is null, not a throw");

    writeFileSync(join(f.dest.root, DESIGN_REUSE_MARKER_FILE), "{ not json", "utf8");
    assert.equal(readDesignReuseMarker(f.dest.root), null, "an unreadable marker is null — never a partial intent");
    writeFileSync(join(f.dest.root, DESIGN_REUSE_MARKER_FILE), '{"sourceRunId":""}', "utf8");
    assert.equal(readDesignReuseMarker(f.dest.root), null, "an empty source id is not an intent");
  } finally {
    f.cleanup();
  }
});

test("the marker is written even when the run directory does not exist yet", () => {
  // The intake path: a plain brief with no references and no documents reaches the
  // marker write with nothing on disk at all, because `createRun` only creates
  // `references/` and `documents/` when the ticket carries some.
  const f = fixture();
  try {
    const fresh = runPathsFor(f.paths, "run-with-no-attachments");
    assert.equal(existsSync(fresh.root), false, "the precondition: nothing is on disk for this run yet");
    writeDesignReuseMarker(fresh.root, { sourceRunId: f.sourceRunId, requestedAt: "2026-08-12T21:00:00.000Z" });
    assert.equal(readDesignReuseMarker(fresh.root)?.sourceRunId, f.sourceRunId);
  } finally {
    f.cleanup();
  }
});

test("the manifest is REWRITTEN rather than copied — no source path is ever on disk in the new run", () => {
  // The staging directory holds the rewritten manifest before the rename, so there
  // is no window in which `<dest>/design-refs/manifest.json` carries the source's
  // absolute paths. Asserted through the one observable a test has: the file that
  // lands is the rewritten one, and the source's own copy is byte-for-byte intact.
  const f = fixture();
  try {
    const source = check(f);
    assert.ok(source.ok);
    const before = readFileSync(manifestPathFor(f.source.workspace), "utf8");
    mkdirSync(f.dest.workspace, { recursive: true });
    assert.ok(copyDesignAssets(source.source, f.dest).ok);
    assert.equal(readFileSync(manifestPathFor(f.source.workspace), "utf8"), before, "the source's manifest is a record");
    assert.notEqual(
      readFileSync(join(refsDirFor(f.dest.workspace), DESIGN_MANIFEST_FILE), "utf8"),
      before,
      "the destination's manifest cannot be a byte copy of the source's",
    );
  } finally {
    f.cleanup();
  }
});
