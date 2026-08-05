/**
 * visual-gate-run.test.ts — does the wire carry current.
 *
 * THAT IS THE ONLY QUESTION THIS FILE ASKS, because the defect it was written
 * against is not a wrong answer — it is an answer nobody ever requested. Before
 * this module `VerdictInput.visualFindings` was declared, consumed at four sites,
 * and assigned by nothing; `ownerReferenceFor` had zero references outside its own
 * file; and `visualCriteriaFor`'s only caller passed `{ lockedMockup: null }` with
 * no owner reference, so a live run emitted exactly zero owner criteria. Every one
 * of those had passing unit tests.
 *
 * SO THE ASSERTIONS HERE ARE DELIBERATELY INTOLERANT OF ABSENCE. An assertion
 * that accepts `[]`, or `null`, or "the field is present", would have passed
 * before any of this work existed. Where a test can only observe the empty case,
 * it says so in its own name and a sibling proves the non-empty one.
 *
 * MOST OF IT RUNS AGAINST THE REAL ARTEFACTS ON DISK, read-only, never modified:
 * the one build that ever passed (2026-07-29), the build that scored 0 of 16
 * (2026-07-30), and the one run in this project's history where the owner
 * attached an image (2026-08-04). Numbers measured from those files are the only
 * calibration this module has, and a fixture I invented would be a calibration
 * against my own imagination.
 *
 * NO PROVIDER IS CALLED AND NO QUOTA IS SPENT. The one observation this path
 * answers is answered by MEASUREMENT — pixels, host-side — which is exactly why
 * it can be tested at all.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { computeOutcome } from "./verdict.js";
import type { VerdictInput } from "./verdict.js";
import {
  OWNER_REF_GROUND_NOTE,
  framesFrom,
  groundOf,
  lightnessOf,
  ownerReferenceGroundNote,
  visualGateRun,
} from "./visual-gate-run.js";
import { REF_GROUND_INVERTED_ID, VISUAL_OBSERVATIONS } from "./visual-substance.js";
import type { VisualObservationOutcome } from "./visual-substance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `dashboard/`, from this test's compiled location two levels down in a dist dir. */
const DASHBOARD = join(HERE, "..", "..");
const REAL_RUNS = join(DASHBOARD, "runs");
const REAL_SHOTS = join(DASHBOARD, "results", "screenshots");

/** The one build that ever passed. Its locked mockup and its captures are DARK. */
const GOOD_RUN = "run-2026-07-29T23-28-46-665Z-3d4d1ccb";
/** Built, scored 0 of 16. Its locked mockup is LIGHT. */
const ZERO_RUN = "run-2026-07-30T20-16-40-242Z-052c6e02";
function haveGoodRun(): boolean {
  return existsSync(join(REAL_SHOTS, GOOD_RUN, "home__1280.png"));
}

/* -------------------------------------------------------------------------
 * 1. The measurement itself, against artefacts nobody here authored
 * ---------------------------------------------------------------------- */

test("lightnessOf is CIELAB L*, anchored at both ends and at the midpoint", () => {
  // Not a golden file: these three are the colour space's own definition. Black
  // is 0, white is 100, and mid-grey sits ABOVE 50 in sRGB — which is the whole
  // reason `POLARITY_MIDPOINT` is a lightness midpoint and not `#808080`.
  assert.equal(Math.round(lightnessOf(0, 0, 0)), 0);
  assert.equal(Math.round(lightnessOf(255, 255, 255)), 100);
  assert.ok(lightnessOf(128, 128, 128) > 50, "sRGB mid-grey is lighter than L* 50");
  assert.ok(lightnessOf(128, 128, 128) < 60, "…but not by much; a wild value here would move every answer");
});

test("REAL ARTEFACTS: the grounds measure what the spec measured, on both polarities", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const darkMockup = await groundOf(join(REAL_RUNS, GOOD_RUN, "workspace", "design-refs", "01-hero.png"));
  const darkBuild = await groundOf(join(REAL_SHOTS, GOOD_RUN, "home__1280.png"));
  assert.notEqual(darkMockup, null, "the locked mockup must decode — it is a JPEG named .png, and that is normal here");
  assert.notEqual(darkBuild, null);
  // §1.2.4 of the design-fidelity spec measured 5.9 / 33.5% for this mockup. This
  // is a re-measurement by a second implementation, not a copy of that number:
  // if the two disagreed, one of them would be wrong and the constants in
  // `visual-substance.ts:504` would be resting on the wrong evidence.
  assert.ok(Math.abs((darkMockup?.lightness ?? 0) - 5.9) < 1, `locked mockup L* ${String(darkMockup?.lightness)}`);
  assert.ok((darkMockup?.share ?? 0) > 0.2, "and it clears the ground-share floor");
  assert.ok((darkBuild?.lightness ?? 0) < 20, `the delivered page is dark too: L* ${String(darkBuild?.lightness)}`);

  // THE OTHER POLARITY, FROM A DIFFERENT RUN. A measurement that only ever sees
  // dark pages cannot be shown to discriminate.
  const lightMockup = await groundOf(join(REAL_RUNS, ZERO_RUN, "workspace", "design-refs", "01-hero.png"));
  assert.ok((lightMockup?.lightness ?? 0) > 90, `the 2026-07-30 lock is light: L* ${String(lightMockup?.lightness)}`);
});

test("groundOf degrades to null rather than throwing, in every way it can fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ground-"));
  assert.equal(await groundOf(join(dir, "absent.png")), null, "a missing file");
  const notAnImage = join(dir, "notes.png");
  writeFileSync(notAnImage, "this is text wearing a png extension", "utf8");
  assert.equal(await groundOf(notAnImage), null, "bytes no decoder recognises");
  // The direction matters more than the value: `groundPolarityAnswer` maps null
  // to `unknown`, which is non-passing AND non-gating, so every failure here
  // degrades to "does not fire" and never to "fires".
});

/* -------------------------------------------------------------------------
 * 2. Frames
 * ---------------------------------------------------------------------- */

test("a flow captured twice at one breakpoint is ONE frame, not two", () => {
  const frames = framesFrom([
    { flowId: "home", breakpoint: "1280x800", file: "home__1280.png" },
    { flowId: "home", breakpoint: "1280x800", file: "home__1280-again.png" },
    { flowId: "home", breakpoint: "375x812", file: "home__375.png" },
  ]);
  assert.equal(frames.length, 2, "a duplicate would double every count downstream");
  assert.equal(frames[0]?.file, "home__1280.png", "and the first capture is the one measured");
});

/* -------------------------------------------------------------------------
 * 3. The good run, end to end — THE RUN THAT MUST NOT CHANGE
 * ---------------------------------------------------------------------- */

async function goodRunGate(mode?: "shadow" | "gating"): ReturnType<typeof visualGateRun> {
  return visualGateRun({
    runId: GOOD_RUN,
    runsRoot: REAL_RUNS,
    workspace: join(REAL_RUNS, GOOD_RUN, "workspace"),
    screenshotDir: join(REAL_SHOTS, GOOD_RUN),
    captures: [
      { flowId: "home", breakpoint: "1280x800", file: "home__1280.png" },
      { flowId: "home", breakpoint: "768x1024", file: "home__768.png" },
      { flowId: "home", breakpoint: "375x812", file: "home__375.png" },
    ],
    ...(mode === undefined ? {} : { mode }),
  });
}

test("REAL RUN: the build that passed is MEASURED, and the measurement says satisfied", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const result = await goodRunGate();
  const measured = result.record.outcomes.filter((row) => row.observationId === REF_GROUND_INVERTED_ID);
  assert.equal(measured.length, 3, "one row per captured frame");
  // THE ASSERTION THAT WOULD HAVE PASSED BEFORE THIS MODULE EXISTED IS THE ONE
  // NOT MADE HERE. `unknown` on every row is what an unwired gate produces, and
  // it is indistinguishable from a clean run unless the verdict word is checked.
  for (const row of measured) {
    assert.equal(
      row.verdict,
      "satisfied",
      `${row.frame.breakpoint}: the locked design and the delivered page are both dark — ${row.note}`,
    );
    assert.equal(row.rawVerdict, "satisfied");
  }
  assert.match(measured[0]?.note ?? "", /both grounds are dark/i);
  assert.match(measured[0]?.note ?? "", /locked L\* \d/u, "and the numbers are on the record, not just the answer");
});

test("REAL RUN: the build that passed keeps its verdict, exactly", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const result = await goodRunGate();
  assert.deepEqual(result.findings, [], "nothing from the visual path may count against this run");
  assert.deepEqual(result.qualityFindings, [], "and no note either — it attached no reference image");

  // Through the arithmetic that actually decides, not by inspection: a passing
  // run with the visual path attached must still compute `pass`.
  const base: VerdictInput = {
    ticket: "a booking site",
    criteriaResults: [
      { criterionId: "C-1", tier: "FUNCTIONAL", passed: true, evidenceRef: null, detail: null },
    ],
    qualityFindings: [...result.qualityFindings],
    assumptions: [],
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
    visualFindings: result.findings,
  };
  assert.equal(computeOutcome(base), "pass", "the §6 trap is a gate that fails the one artefact that succeeded");
});

test("REAL RUN: gating mode does not change the answer for the build that passed", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  // The mode flag is the loudest lever in this family, so the good build is
  // driven with it ON as well. Its safety is a property of the PAGE — the ground
  // polarities agree — and not of the flag being off.
  const result = await goodRunGate("gating");
  assert.equal(result.record.mode, "gating");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.record.violations, [], "nothing even fired, let alone counted");
});

/* -------------------------------------------------------------------------
 * 4. The shadow lock — the guard that stops an uncalibrated check gating
 * ---------------------------------------------------------------------- */

/**
 * A run whose locked design is DARK and whose delivered page is LIGHT.
 *
 * BUILT FROM TWO REAL LOCKS RATHER THAN FROM PAINT. The "mockup" is the 2026-07-29
 * lock (measured L* 5.9) and the "delivered capture" is the 2026-07-30 lock
 * (measured L* 95.6). Both are artefacts a Gemini seat actually produced for this
 * project, so the inversion under test is one this pipeline can really emit —
 * not a pair of flat rectangles chosen to make the arithmetic work.
 */
function invertedRun(): { runs: string; runId: string; workspace: string; shots: string } {
  const runs = mkdtempSync(join(tmpdir(), "vis-gate-"));
  const runId = "run-inverted";
  const workspace = join(runs, runId, "workspace");
  const refs = join(workspace, "design-refs");
  const shots = join(runs, "shots");
  mkdirSync(refs, { recursive: true });
  mkdirSync(shots, { recursive: true });
  return { runs, runId, workspace, shots };
}

function writeManifest(workspace: string, lockedMockup: string): void {
  writeFileSync(
    // BESIDE THE REFS, NOT AT THE WORKSPACE ROOT. `manifestPathFor` is
    // `<workspace>/design-refs/manifest.json`; a file one directory up parses as
    // no manifest at all, which is the DEGRADED state — and every fidelity
    // assertion below would then be measuring nothing and reporting green.
    join(workspace, "design-refs", "manifest.json"),
    JSON.stringify({
      version: 1,
      // THE DISK KEY IS `locked` AND THE PARSED FIELD IS `lockedMockup`
      // (design-manifest.ts:16-17). Writing the parsed name here produces a
      // manifest that parses cleanly with NO LOCK — which is the degraded state,
      // and every fidelity assertion below would then be measuring nothing while
      // reporting green.
      locked: lockedMockup,
      lockedBy: "ui-designer",
      lockedReason: "the fixture's lock, so the comparison has a referent",
      lockedAt: "2026-08-05T00:00:00.000Z",
      directions: [],
      chosenDirection: null,
      directionChoice: null,
      refs: [
        {
          path: lockedMockup,
          section: "hero",
          aspect: "16:9",
          intent: "the hero",
          direction: null,
          origin: null,
        },
      ],
    }),
    "utf8",
  );
}

async function invertedGate(mode: "shadow" | "gating"): ReturnType<typeof visualGateRun> {
  const h = invertedRun();
  const locked = join(h.workspace, "design-refs", "01-hero.png");
  const capture = "delivered.png";
  writeFileSync(locked, readReal(join(REAL_RUNS, GOOD_RUN, "workspace", "design-refs", "01-hero.png")));
  writeFileSync(join(h.shots, capture), readReal(join(REAL_RUNS, ZERO_RUN, "workspace", "design-refs", "01-hero.png")));
  writeManifest(h.workspace, locked);
  return visualGateRun({
    runId: h.runId,
    runsRoot: h.runs,
    workspace: h.workspace,
    screenshotDir: h.shots,
    captures: [{ flowId: "home", breakpoint: "1280x800", file: capture }],
    mode,
  });
}

/** Read a REAL artefact. Read-only, always — a run directory is never modified. */
function readReal(path: string): Buffer {
  return readFileSync(path);
}

test("AN INVERTED BUILD IS DETECTED — the measurement fires", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const result = await invertedGate("shadow");
  const fired = result.record.violations.filter((row) => row.observationId === REF_GROUND_INVERTED_ID);
  assert.equal(fired.length, 1, "a dark locked design delivered as a light page IS an inversion");
  assert.match(fired[0]?.note ?? "", /inverted the polarity of the design that was chosen/i);
  // The must-fire half. Without it every assertion below — "and it still cannot
  // fail the run" — would be satisfied by a measurement that fires on nothing at
  // all, which is this project's recorded M4 defect.
});

test("…AND IT STILL CANNOT FAIL THE RUN, IN EITHER MODE, BECAUSE THE ENTRY IS SHADOW-LOCKED", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  for (const mode of ["shadow", "gating"] as const) {
    const result = await invertedGate(mode);
    assert.ok(result.record.violations.length > 0, `${mode}: it fired`);
    assert.deepEqual(result.findings, [], `${mode}: and nothing reached the verdict`);
    for (const row of result.record.violations) {
      assert.equal(row.gating, false, `${mode}: ${row.observationId} must not be marked gating`);
      assert.equal(row.withheldBecause, "entry_shadow_locked", `${mode}: and it must say WHY it was withheld`);
    }
  }
  // THE LOCK IS THE LOAD-BEARING PART AND ITS REASON IS STILL LIVE:
  // `bakeoff/src/scorer-container.ts:632` pins `colorScheme: "light"` in every
  // capture context, so a correct dark-mode build under `prefers-color-scheme`
  // renders light and is byte-identical to a deliberate inversion. Until that
  // changes, an unlocked entry here would fail correct builds.
  const entry = VISUAL_OBSERVATIONS.find((o) => o.id === REF_GROUND_INVERTED_ID);
  assert.equal(entry?.shadowLocked, true, "if this ever flips, the test above becomes a live gate");
});

/* -------------------------------------------------------------------------
 * 5. The owner's own image — the criteria, the note, and the fence
 * ---------------------------------------------------------------------- */

interface OwnerHarness {
  readonly runs: string;
  readonly runId: string;
  readonly workspace: string;
  readonly shots: string;
  readonly attach: (source: string) => void;
  readonly attachForged: (source: string) => void;
  readonly lock: (source: string) => void;
}

function ownerHarness(): OwnerHarness {
  const runs = mkdtempSync(join(tmpdir(), "vis-owner-"));
  const runId = "run-owner";
  const workspace = join(runs, runId, "workspace");
  const references = join(runs, runId, "references");
  const shots = join(runs, "shots");
  mkdirSync(join(workspace, "design-refs"), { recursive: true });
  mkdirSync(references, { recursive: true });
  mkdirSync(shots, { recursive: true });
  const put = (source: string, digestOf: (bytes: Buffer) => string): void => {
    const bytes = readReal(source);
    const path = join(references, "reference-1.png");
    writeFileSync(path, bytes);
    writeFileSync(
      join(references, "references.json"),
      JSON.stringify({
        images: [{ path, sha256: digestOf(bytes), bytes: bytes.byteLength }],
        capture: null,
      }),
      "utf8",
    );
  };
  return {
    runs,
    runId,
    workspace,
    shots,
    attach: (source) => {
      put(source, (bytes) => createHash("sha256").update(bytes).digest("hex"));
    },
    attachForged: (source) => {
      // The manifest claims a digest the bytes do not have. `owner-reference.ts`
      // checks the BYTES, because that digest is what the ticket id was minted
      // from and a reference whose bytes drifted is not the design this run is
      // being graded under.
      put(source, () => "a".repeat(64));
    },
    lock: (source) => {
      const locked = join(workspace, "design-refs", "01-hero.png");
      writeFileSync(locked, readReal(source));
      writeManifest(workspace, locked);
    },
  };
}

const DARK_MOCKUP = (): string => join(REAL_RUNS, GOOD_RUN, "workspace", "design-refs", "01-hero.png");
const LIGHT_MOCKUP = (): string => join(REAL_RUNS, ZERO_RUN, "workspace", "design-refs", "01-hero.png");

test("THE OWNER'S IMAGE REACHES THE CRITERIA — and they say so is his, not a mockup's", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const h = ownerHarness();
  h.lock(DARK_MOCKUP());
  h.attach(DARK_MOCKUP());
  const result = await visualGateRun({
    runId: h.runId,
    runsRoot: h.runs,
    workspace: h.workspace,
    screenshotDir: h.shots,
    captures: [],
  });
  assert.notEqual(result.ownerReference, null, "the validated reference must have resolved");
  const owned = result.taste.filter((criterion) => criterion.referent === "owner-image");
  assert.equal(owned.length, 2, "VIS-OWNER-REF-FOLLOWED and VIS-OWNER-REF-PALETTE, and nothing else");
  assert.deepEqual(
    owned.map((criterion) => criterion.id).sort(),
    ["VIS-OWNER-REF-FOLLOWED", "VIS-OWNER-REF-PALETTE"],
  );
  for (const criterion of owned) {
    assert.equal(criterion.reference, result.ownerReference?.path, "pointing at HIS file, not at the lock");
    assert.equal(criterion.tier, "QUALITY", "taste reports and never blocks — owner decision, 2026-07-28");
  }
  // AND THE REPORT SAYS IT OUT LOUD. A criterion that exists in memory and
  // appears nowhere is the same absence in a smaller font.
  assert.match(result.report, /2 of the statements above are about the image the OWNER supplied/);
  assert.match(result.report, /about the image YOU attached to the ticket/);
});

test("WITH NO ATTACHED IMAGE THE OWNER CRITERIA ARE ABSENT — never defaulted to the mockup", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const h = ownerHarness();
  h.lock(DARK_MOCKUP());
  const result = await visualGateRun({
    runId: h.runId,
    runsRoot: h.runs,
    workspace: h.workspace,
    screenshotDir: h.shots,
    captures: [],
  });
  assert.equal(result.ownerReference, null);
  assert.equal(result.taste.filter((c) => c.referent === "owner-image").length, 0);
  // The failure this refuses: falling back to the locked mockup would make every
  // run report GREEN on "did you follow the design he supplied", including every
  // run where he supplied none. A check that can only observe success.
  assert.ok(
    result.taste.some((c) => c.referent === "locked-mockup"),
    "the lock's own criteria are still there — this is absence, not breakage",
  );
  assert.match(result.report, /No criterion on this run points at an image the owner supplied/);
});

test("THE FENCE HOLDS THROUGH THE WIRING: a forged digest yields no owner criteria", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const h = ownerHarness();
  h.lock(DARK_MOCKUP());
  h.attachForged(LIGHT_MOCKUP());
  const result = await visualGateRun({
    runId: h.runId,
    runsRoot: h.runs,
    workspace: h.workspace,
    screenshotDir: h.shots,
    captures: [],
  });
  assert.equal(result.ownerReference, null, "the bytes decide, not the manifest");
  assert.equal(result.taste.filter((c) => c.referent === "owner-image").length, 0);
  assert.deepEqual(result.qualityFindings, [], "and the note it would have produced is not produced either");
  // The same file with an HONEST digest DOES produce both — proving the refusal
  // above is the digest check and not the fixture being unusable.
  const ok = ownerHarness();
  ok.lock(DARK_MOCKUP());
  ok.attach(LIGHT_MOCKUP());
  const passed = await visualGateRun({
    runId: ok.runId,
    runsRoot: ok.runs,
    workspace: ok.workspace,
    screenshotDir: ok.shots,
    captures: [],
  });
  assert.notEqual(passed.ownerReference, null);
  assert.equal(passed.taste.filter((c) => c.referent === "owner-image").length, 2);
});

test("A QUALITY NOTE IS PRODUCED when the locked design inverts the owner's reference", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const h = ownerHarness();
  h.lock(DARK_MOCKUP()); // the design a model generated: dark
  h.attach(LIGHT_MOCKUP()); // the image he actually sent: light
  const result = await visualGateRun({
    runId: h.runId,
    runsRoot: h.runs,
    workspace: h.workspace,
    screenshotDir: h.shots,
    captures: [],
  });
  assert.equal(result.qualityFindings.length, 1, "this is the array that must not be empty");
  const note = result.qualityFindings[0] ?? "";
  assert.ok(note.startsWith(OWNER_REF_GROUND_NOTE));
  assert.match(note, /locked design's ground is DARK/);
  assert.match(note, /your reference's is LIGHT/i);
  assert.match(note, /one regeneration/, "and it names the CHEAP fix, not 'rebuild'");
  assert.doesNotMatch(note, /\//u, "no path may reach verdict.md — it is served to the UI");

  // AND IT REACHES THE VERDICT AS A NOTE, NEVER AS A FAILURE.
  const input: VerdictInput = {
    ticket: "build the design I attached",
    criteriaResults: [
      { criterionId: "C-1", tier: "FUNCTIONAL", passed: true, evidenceRef: null, detail: null },
    ],
    qualityFindings: [...result.qualityFindings],
    assumptions: [],
    heldOutUnmet: { BLOCKING: 0, FUNCTIONAL: 0, QUALITY: 0 },
    visualFindings: result.findings,
  };
  assert.equal(computeOutcome(input), "pass_with_notes", "reports; never blocks");
  assert.equal(
    computeOutcome({ ...input, qualityFindings: [] }),
    "pass",
    "and without the note the same run is a clean pass — so the note is what moved it",
  );
});

test("MATCHING POLARITIES PRODUCE NO NOTE — the must-not-fire half", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const h = ownerHarness();
  h.lock(DARK_MOCKUP());
  h.attach(DARK_MOCKUP());
  const result = await visualGateRun({
    runId: h.runId,
    runsRoot: h.runs,
    workspace: h.workspace,
    screenshotDir: h.shots,
    captures: [],
  });
  assert.deepEqual(result.qualityFindings, [], "a dark design against a dark reference is not a divergence");
});

test("the owner-reference note refuses every case it cannot decide", () => {
  const dark = { lightness: 6, share: 0.4 };
  const light = { lightness: 95, share: 0.4 };
  assert.notEqual(ownerReferenceGroundNote({ locked: dark, owner: light }), null, "the must-fire case");
  assert.equal(ownerReferenceGroundNote({ locked: null, owner: light }), null, "no lock");
  assert.equal(ownerReferenceGroundNote({ locked: dark, owner: null }), null, "no image");
  assert.equal(
    ownerReferenceGroundNote({ locked: { lightness: 6, share: 0.05 }, owner: light }),
    null,
    "a lock with no dominant ground — 'the design's polarity' names nothing",
  );
  assert.equal(
    ownerReferenceGroundNote({ locked: { lightness: 52, share: 0.4 }, owner: light }),
    null,
    "a ground sitting in the ambiguous band around the midpoint",
  );
  assert.equal(ownerReferenceGroundNote({ locked: dark, owner: { lightness: 12, share: 0.4 } }), null, "same polarity");
});

/* -------------------------------------------------------------------------
 * 6. What a run with no captures produces — and what it must NOT produce
 * ---------------------------------------------------------------------- */

test("a run that captured nothing is UNKNOWN on every observation, never clean", async () => {
  const h = ownerHarness();
  const result = await visualGateRun({
    runId: h.runId,
    runsRoot: h.runs,
    workspace: h.workspace,
    screenshotDir: h.shots,
    captures: [],
  });
  assert.equal(result.record.outcomes.length, VISUAL_OBSERVATIONS.length, "one row per observation, still");
  for (const row of result.record.outcomes) {
    assert.equal(row.verdict, "unknown");
    assert.equal(row.unknownReason, "no_screenshot");
  }
  assert.deepEqual(result.findings, []);
  assert.match(result.report, /no capture was written on this run/);
});

test("the three GRADER-answered observations come back unanswered, and say so", async (t) => {
  if (!haveGoodRun()) {
    t.skip("the real run artefacts are not on this machine");
    return;
  }
  const result = await goodRunGate();
  const graderRows: VisualObservationOutcome[] = result.record.outcomes.filter(
    (row) => row.observationId !== REF_GROUND_INVERTED_ID,
  );
  assert.ok(graderRows.length > 0);
  for (const row of graderRows) {
    assert.equal(row.verdict, "unknown", `${row.observationId} has no grader on this path`);
    assert.equal(row.unknownReason, "not_answered");
  }
  // STATED AS A LIMIT, NOT HIDDEN AS A PASS. There is no visual-grader seat on
  // the run path today: `visualGatePrompt` still has zero non-test callers. This
  // module answers the one observation a HOST can answer and reports the rest
  // unanswered, which is not a pass — `verdict.ts` counts only `violated`.
});
