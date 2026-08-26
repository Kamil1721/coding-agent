/**
 * api-references.test.ts — `POST /api/runs` as a TICKET INTAKE, over a real
 * loopback server.
 *
 * A SEPARATE FILE FROM `api.test.ts` ON PURPOSE. That file is the frozen
 * contract's own test and was being edited in the same session as this change;
 * this one owns a single concern — what the create-run route does with reference
 * images and with a page named in the ticket — and carries its own trimmed
 * harness rather than widening that one's.
 *
 * THE ORCHESTRATOR IS STUBBED. Starting a real run spawns a builder subprocess
 * and spends the owner's quota. THE CAPTURE IS STUBBED TOO, through
 * `HttpDeps.captureSite`: this test must never launch a browser or reach the
 * network, and the seam exists so that the route's own decisions — the ticket's
 * identity, the bytes on disk, the manifest, and what the owner is told when the
 * capture fails — can be observed without one.
 *
 * WHAT THAT MEANS FOR WHAT THIS PROVES. Every assertion below is about the
 * ROUTE. None of them is evidence that a real capture works; `site-capture.ts`
 * has never run against chromium. The two files are deliberately not allowed to
 * launder each other's coverage.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import type { CreateRunResponse, RunDetail, SseEvent } from "./api-types.js";
import { MOTION_BLOCK_BEGIN } from "./motion-brief.js";
import type { MotionCaptureResult } from "./motion-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { GateProbe } from "./health-gate.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { HttpDeps, RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import type { SiteCapture, SiteCaptureResult } from "./site-capture.js";
import { readReferenceManifest, referenceDirFor } from "./ticket-refs.js";
import { ticketFromStoredReferences, ticketFromText } from "./ticket.js";

const FAKE_MODELS: readonly ModelInfo[] = [
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

const OUTLINE_HEADING = "Selected work";

function fakeCapture(url: string): SiteCapture {
  return {
    url,
    capturedAt: "2026-07-30T12:00:00.000Z",
    shots: [{ width: 1280, path: "/tmp/x/capture-1280.png", sha256: "aa", bytes: 3 }],
    outline: {
      url,
      title: "Kamil Borzęcki",
      headings: [
        { level: 1, text: "Kamil Borzęcki" },
        { level: 2, text: OUTLINE_HEADING },
      ],
      links: ["Home", "Work"],
      palette: ["#111111"],
    },
  };
}

/**
 * A raw motion reading, as the injected `captureMotion` seam returns one.
 *
 * RAW AND NOT NORMALISED, DELIBERATELY. `captureMotion` returns a
 * `MotionReading` and the ROUTE is what calls `normaliseMotion` on it, so a stub
 * that handed back a finished spec would leave the route's own quantization step
 * untested — the 487 ms below must reach the manifest as 500.
 */
function fakeMotion(url: string): MotionCaptureResult {
  return {
    ok: true,
    reading: {
      url,
      capturedAt: "2026-08-04T09:00:00.000Z",
      observations: [
        {
          family: "scroll-reveal",
          role: "div.card",
          props: ["opacity", "transform"],
          durationMs: 487,
          firstChangeMs: 200,
          easing: "ease-out",
          iterations: 1,
          scrollRatio: null,
        },
      ],
      libraries: ["gsap"],
      respectsReducedMotion: true,
    },
  };
}

interface Harness {
  readonly base: string;
  readonly store: RunStore;
  readonly paths: DashboardPaths;
  /** Every URL the route asked to capture. Empty means it never tried. */
  readonly captureCalls: string[];
  /** Every URL the route asked to READ THE MOTION OF. Kept apart from the above:
   * the two capture paths take different inputs and a test that could not tell
   * them apart would pass while the route sent a motion reference to the outline
   * capture. */
  readonly motionCalls: string[];
  close(): Promise<void>;
}

async function startHarness(
  capture: (url: string) => SiteCaptureResult | Promise<SiteCaptureResult>,
  motion: (url: string) => MotionCaptureResult | Promise<MotionCaptureResult> = fakeMotion,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-refs-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  /*
   * A LOGGED-IN CLAUDE STUB, because the catalog refuses to list any model when
   * the probe says otherwise — `ModelCatalog.entries` only emits rows for a
   * real login, and every submission below would 409 on `model_unavailable`
   * before reaching a single line of the code this file is about. Same shape as
   * `api.test.ts`'s harness: a throwaway executable, so the actual `execFile`
   * probe runs rather than a mock of it.
   */
  const claudeBin = join(dir, "claude-stub");
  writeFileSync(claudeBin, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n', "utf8");
  chmodSync(claudeBin, 0o755);
  const auth = new AuthProbe({ claudeBin, codexBin: join(dir, "nope"), env: process.env });
  const catalog = new ModelCatalog(auth, {}, async () => FAKE_MODELS);
  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: () => false,
    resume: () => false,
    pushLiveMessage: () => false,
  };
  const captureCalls: string[] = [];
  const motionCalls: string[] = [];

  const deps: HttpDeps = {
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
    gateReadiness: READY_GATE_READINESS,
    captureSite: async (options) => {
      captureCalls.push(options.url);
      return await capture(options.url);
    },
    captureMotion: async (options) => {
      motionCalls.push(options.url);
      return await motion(options.url);
    },
  };
  const server = createDashboardServer(deps);
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    store,
    paths,
    captureCalls,
    motionCalls,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const okCapture = (url: string): SiteCaptureResult => ({ ok: true, capture: fakeCapture(url) });
const failedCapture = (): SiteCaptureResult => ({ ok: false, reason: "the browser could not be started: no chromium" });

async function submit(harness: Harness, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${harness.base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: "opus[1m]", ...body }),
  });
}

function pngDataUrl(seed: string, bytes = 32): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, seed.charCodeAt(0)).toString("base64")}`;
}

function logLines(harness: Harness, runId: string): readonly { level: string; text: string }[] {
  return harness.store
    .eventsSince(runId, 0)
    .map((stored) => stored.event as SseEvent)
    .filter((event): event is Extract<SseEvent, { type: "log" }> => event.type === "log")
    .map((event) => ({ level: event.level, text: event.text }));
}

/* -------------------------------------------------------------------------
 * Reference images
 * ---------------------------------------------------------------------- */

test("reference images are written to disk, recorded as PATHS, and change the ticket id", async () => {
  const harness = await startHarness(okCapture);
  try {
    const text = "Build me a portfolio page";
    const plain = await submit(harness, { ticketText: text });
    const withRefs = await submit(harness, { ticketText: text, references: [pngDataUrl("a"), pngDataUrl("b")] });
    assert.equal(plain.status, 201);
    assert.equal(withRefs.status, 201);

    const plainId = ((await plain.json()) as CreateRunResponse).runId;
    const refsId = ((await withRefs.json()) as CreateRunResponse).runId;
    const plainRow = harness.store.getRun(plainId);
    const refsRow = harness.store.getRun(refsId);

    assert.equal(plainRow?.ticketId, ticketFromText(text).id, "no references: the id is unchanged, forever");
    assert.notEqual(refsRow?.ticketId, plainRow?.ticketId, "the owner's decision: references are part of identity");
    assert.equal(refsRow?.ticketText, text, "an image adds no text to the brief the spec seat reads");
    assert.equal(refsRow?.ticketSha256, plainRow?.ticketSha256, "sha256 stays the digest of the brief");

    const dir = referenceDirFor(harness.paths.runs, refsId);
    assert.ok(existsSync(join(dir, "reference-1.png")));
    assert.ok(existsSync(join(dir, "reference-2.png")));
    const manifest = readReferenceManifest(dir);
    assert.equal(manifest?.images.length, 2);
    assert.ok(manifest?.images[0]?.path.endsWith("reference-1.png"));
    assert.equal(manifest?.capture, null, "no URL in this ticket, so no capture");

    assert.equal(readFileSync(join(dir, "reference-1.png")).byteLength, 32);
    // THE BYTES ARE NOT IN THE DATABASE. The row is the thing that gets read on
    // every list poll; a 2 MB PNG base64'd into it is what the path indirection
    // exists to prevent, and only this line watches for it.
    const rowJson = JSON.stringify(refsRow);
    assert.ok(!rowJson.includes("data:image"), "no data URL survived into the row");
    assert.ok(!rowJson.includes(Buffer.alloc(32, "a".charCodeAt(0)).toString("base64")), "and neither did the bytes");
  } finally {
    await harness.close();
  }
});

test("an image larger than the OLD 1 MiB body cap now reaches the image cap that is advertised", async () => {
  // THE REGRESSION THIS PINS. `readBody` had one global 1 MiB cap, so the
  // documented 8 MB-per-image limit was unreachable: a 2 MB PNG is ~2.7 MB of
  // base64 and died as "request body too large" before any image validation ran.
  const harness = await startHarness(okCapture);
  try {
    const response = await submit(harness, {
      ticketText: "Copy this design",
      references: [pngDataUrl("a", 2 * 1024 * 1024)],
    });
    const body = (await response.json()) as CreateRunResponse & { message?: string };
    assert.equal(response.status, 201, body.message ?? "");
    const runId = body.runId;
    const dir = referenceDirFor(harness.paths.runs, runId);
    assert.equal(readFileSync(join(dir, "reference-1.png")).byteLength, 2 * 1024 * 1024);
  } finally {
    await harness.close();
  }
});

test("a bad reference is refused with the reason, and nothing is written", async () => {
  const harness = await startHarness(okCapture);
  try {
    const tooMany = await submit(harness, {
      ticketText: "x",
      references: Array.from({ length: 7 }, (_, index) => pngDataUrl(String(index))),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(((await tooMany.json()) as { error: string }).error, "too_many_images");

    const wrongType = await submit(harness, { ticketText: "x", references: ["data:text/html;base64,PGgxPmE8L2gxPg=="] });
    assert.equal(wrongType.status, 400);
    assert.equal(((await wrongType.json()) as { error: string }).error, "invalid_image");

    const notArray = await submit(harness, { ticketText: "x", references: "one image" });
    assert.equal(notArray.status, 400);

    assert.equal(harness.store.listRuns().length, 0, "a refused submission creates no run");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The site capture
 * ---------------------------------------------------------------------- */

test("a URL in the ticket is captured, and the OUTLINE lands in the text the suite is written from", async () => {
  const harness = await startHarness(okCapture);
  try {
    const text = "Make a copy of https://kamilborzecki.dev";
    const response = await submit(harness, { ticketText: text });
    assert.equal(response.status, 201);
    const runId = ((await response.json()) as CreateRunResponse).runId;
    const row = harness.store.getRun(runId);
    assert.ok(row !== null);

    assert.deepEqual(harness.captureCalls, ["https://kamilborzecki.dev/"]);
    // THE POINT OF THE WHOLE CHANGE. The spec seat has `tools: []` and reads
    // `ticketText` and nothing else; this is the only way a real heading off the
    // real page can reach the criteria it authors.
    assert.ok(row?.ticketText.includes(OUTLINE_HEADING), "the captured outline is part of the brief");
    assert.ok(row?.ticketText.startsWith(text), "the owner's words are still first and unedited");
    assert.notEqual(row?.ticketId, ticketFromText(text).id, "a captured ticket is not the prose-only ticket");
    // THE INVARIANT THE BAKE-OFF ENFORCES (`spec-agent.ts:632`): the recorded
    // digest is the digest of the brief that was recorded beside it. A capture
    // widens the brief, so it must widen this too — and if it ever did not, the
    // spec phase would throw at the first seat rather than here.
    assert.equal(row?.ticketSha256, ticketFromText(row.ticketText).sha256);

    // NO PATH IN THE BRIEF. The screenshots are for the builder; naming a file
    // to a seat that cannot open one produces criteria about an unseen picture.
    assert.ok(!row?.ticketText.includes("capture-1280.png"));

    const manifest = readReferenceManifest(referenceDirFor(harness.paths.runs, runId));
    assert.equal(manifest?.capture?.shots.length, 1, "the screenshots are recorded for the build prompt");

    const logs = logLines(harness, runId);
    assert.ok(
      logs.some((line) => line.level === "info" && line.text.includes("captured https://kamilborzecki.dev/")),
      "the owner is told the capture happened",
    );
    assert.ok(
      logs.some((line) => /no network|never compares/.test(line.text)),
      "and is told what the gate still cannot do, so the capture is not read as a visual check",
    );
  } finally {
    await harness.close();
  }
});

test("A FAILED CAPTURE STILL CREATES THE RUN, and says so — the negative control", async () => {
  const harness = await startHarness(failedCapture);
  try {
    const text = "Make a copy of https://kamilborzecki.dev";
    const response = await submit(harness, { ticketText: text });
    assert.equal(response.status, 201, "a third-party site being down is not a reason to refuse a ticket");
    const runId = ((await response.json()) as CreateRunResponse).runId;
    const row = harness.store.getRun(runId);

    assert.equal(row?.ticketText, text, "with no capture the brief is the prose, byte for byte");
    assert.equal(row?.ticketId, ticketFromText(text).id, "and the ticket is the prose-only ticket");

    const logs = logLines(harness, runId);
    const warning = logs.find((line) => line.level === "warn");
    assert.ok(warning !== undefined, "a silent failure here is a run graded from the sentence alone");
    assert.match(warning.text, /was NOT captured/);
    assert.match(warning.text, /no chromium/, "the real cause survives into the trace");
    assert.match(warning.text, /from your words alone/, "and what that costs is stated");
  } finally {
    await harness.close();
  }
});

test("a ticket pointing at this machine is never fetched", async () => {
  const harness = await startHarness(okCapture);
  try {
    // The attack this refusal exists for: the dashboard's own API spends the
    // owner's subscription quota and lives on exactly this address.
    const response = await submit(harness, { ticketText: "copy http://127.0.0.1:4176/api/runs" });
    assert.equal(response.status, 201);
    const runId = ((await response.json()) as CreateRunResponse).runId;

    assert.deepEqual(harness.captureCalls, [], "the browser was never even asked");
    const logs = logLines(harness, runId);
    assert.ok(logs.some((line) => line.level === "warn" && /this machine/.test(line.text)));
  } finally {
    await harness.close();
  }
});

test("captureUrl null is the opt-out, and a string overrides the scan", async () => {
  const harness = await startHarness(okCapture);
  try {
    const cited = await submit(harness, {
      ticketText: "Follow the spec at https://developer.mozilla.org/en-US/docs/Web",
      captureUrl: null,
    });
    assert.equal(cited.status, 201);
    assert.deepEqual(harness.captureCalls, [], "a ticket that merely cites a URL can say so");

    const overridden = await submit(harness, {
      ticketText: "Copy the site https://a.example, but really I mean the other one",
      captureUrl: "https://b.example/home",
    });
    assert.equal(overridden.status, 201);
    assert.deepEqual(harness.captureCalls, ["https://b.example/home"]);

    const bad = await submit(harness, { ticketText: "x", captureUrl: 7 });
    assert.equal(bad.status, 400);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The MOTION reference — a second, separately addressed capture
 *
 * THE SAME STUBBING RULE AS ABOVE, and it matters more here: `captureMotion`
 * drives a real chromium through five phases. Every assertion below is about
 * what the ROUTE does with a reading, and none of them is evidence that a real
 * reading is correct — `motion-capture.browser.test.ts` is the file that owns
 * that claim, and it launches an actual browser to make it.
 * ---------------------------------------------------------------------- */

test("a motion reference is read, quantized, and becomes part of what the ticket IS", async () => {
  const harness = await startHarness(okCapture);
  try {
    const text = "Build me a portfolio page";
    const response = await submit(harness, { ticketText: text, motionUrl: "https://motion.example/" });
    assert.equal(response.status, 201);
    const runId = ((await response.json()) as CreateRunResponse).runId;
    const row = harness.store.getRun(runId);
    assert.ok(row !== null);

    assert.deepEqual(harness.motionCalls, ["https://motion.example/"]);
    assert.deepEqual(harness.captureCalls, [], "a motion reference is not an outline capture");

    // THE POINT OF THE WHOLE CHANGE, again: the spec seat has `tools: []` and
    // reads `ticketText`. This block is the only way a duration read off a real
    // page can reach the criteria it authors.
    assert.ok(row?.ticketText.includes(MOTION_BLOCK_BEGIN), "the reading is part of the brief");
    assert.ok(row?.ticketText.includes("500ms"), "and the ROUTE quantized it — the stub reported 487ms");
    assert.ok(row?.ticketText.startsWith(text), "the owner's words are still first and unedited");
    assert.notEqual(row?.ticketId, ticketFromText(text).id, "a motion ticket is not the prose-only ticket");
    assert.equal(row?.ticketSha256, ticketFromText(row.ticketText).sha256, "sha256 is still the brief's digest");

    // NO ATTACHMENT SENTENCE. The same wall the images are behind: this block
    // goes to a seat that cannot open anything.
    assert.ok(!/\battach/i.test(row?.ticketText ?? ""));

    const manifest = readReferenceManifest(referenceDirFor(harness.paths.runs, runId));
    assert.equal(manifest?.motion?.entries.length, 1, "the reading is persisted for the read-back id and the prompts");
    assert.equal(manifest?.motion?.entries[0]?.durationMs, 500);

    const logs = logLines(harness, runId);
    assert.ok(
      logs.some((line) => line.level === "info" && line.text.includes("https://motion.example/")),
      "the owner is told the reading happened",
    );
    assert.ok(
      logs.some((line) => /nothing in this run compares|no gate/i.test(line.text)),
      "and is told that nothing measures it, so the reading is not read as an enforced check",
    );
  } finally {
    await harness.close();
  }
});

test("THE READ-BACK ID MATCHES THE ONE THE ROUTE PERSISTED", async () => {
  // THE FAILURE THIS CATCHES IS SILENT AND EXPENSIVE. `orchestrator.ts` rebuilds
  // the ticket from `row.ticketText` plus the manifest on disk; if the intake
  // folds something into the id that the manifest does not carry, the run
  // derives a different id, does not find the frozen suite, and authors a second
  // one on the owner's quota. It does not throw and it does not fail to compile.
  const harness = await startHarness(okCapture);
  try {
    const response = await submit(harness, {
      ticketText: "Build me a portfolio page",
      motionUrl: "https://motion.example/",
    });
    const runId = ((await response.json()) as CreateRunResponse).runId;
    const row = harness.store.getRun(runId);
    const manifest = readReferenceManifest(referenceDirFor(harness.paths.runs, runId));
    assert.equal(ticketFromStoredReferences(row?.ticketText ?? "", manifest).id, row?.ticketId);
  } finally {
    await harness.close();
  }
});

test("A FAILED MOTION READING STILL CREATES THE RUN, and says so — the negative control", async () => {
  const harness = await startHarness(okCapture, () => ({
    ok: false,
    reason: "the browser could not be started: no chromium",
  }));
  try {
    const text = "Build me a portfolio page";
    const response = await submit(harness, { ticketText: text, motionUrl: "https://motion.example/" });
    assert.equal(response.status, 201, "a third-party site being slow is not a reason to refuse a ticket");
    const runId = ((await response.json()) as CreateRunResponse).runId;
    const row = harness.store.getRun(runId);

    assert.equal(row?.ticketText, text, "with no reading the brief is the prose, byte for byte");
    assert.equal(row?.ticketId, ticketFromText(text).id, "and the ticket is the prose-only ticket");

    const warning = logLines(harness, runId).find((line) => line.level === "warn");
    assert.ok(warning !== undefined, "a silent failure here is a ticket that quietly lost its reference");
    assert.match(warning.text, /was NOT read/);
    assert.match(warning.text, /no chromium/, "the real cause survives into the trace");
  } finally {
    await harness.close();
  }
});

test("A READING THAT OBSERVED NOTHING is not a failure, and is not silence either", async () => {
  // TWO ANSWERS THAT MUST NOT COLLAPSE INTO ONE (motion-capture.ts says so): a
  // page that could not be read, and a page that was read and does not move.
  const harness = await startHarness(okCapture, (url) => ({
    ok: true,
    reading: {
      url,
      capturedAt: "2026-08-04T09:00:00.000Z",
      observations: [],
      libraries: [],
      respectsReducedMotion: false,
    },
  }));
  try {
    const text = "Build me a portfolio page";
    const response = await submit(harness, { ticketText: text, motionUrl: "https://still.example/" });
    const runId = ((await response.json()) as CreateRunResponse).runId;
    const row = harness.store.getRun(runId);

    assert.ok(!row?.ticketText.includes(MOTION_BLOCK_BEGIN), "no entries, no block — nothing to author from");
    assert.notEqual(row?.ticketId, ticketFromText(text).id, "but a page WAS chosen, and that is identity");
    const manifest = readReferenceManifest(referenceDirFor(harness.paths.runs, runId));
    assert.equal(manifest?.motion?.entries.length, 0, "the empty reading is persisted, not discarded");
    assert.equal(
      ticketFromStoredReferences(row?.ticketText ?? "", manifest).id,
      row?.ticketId,
      "and the read-back agrees, which is the only reason the id above is safe to move",
    );
    assert.ok(logLines(harness, runId).some((line) => /nothing was observed to move/i.test(line.text)));
  } finally {
    await harness.close();
  }
});

test("a motion reference pointing at this machine is never fetched", async () => {
  const harness = await startHarness(okCapture);
  try {
    const response = await submit(harness, {
      ticketText: "Build me a portfolio page",
      motionUrl: "http://127.0.0.1:4176/api/runs",
    });
    assert.equal(response.status, 201);
    const runId = ((await response.json()) as CreateRunResponse).runId;
    // THE SAME REFUSAL LIST THE OUTLINE CAPTURE USES, reached through the same
    // function: a second copy of it here would drift from the first.
    assert.deepEqual(harness.motionCalls, [], "the browser was never even asked");
    assert.ok(logLines(harness, runId).some((line) => line.level === "warn" && /this machine/.test(line.text)));
  } finally {
    await harness.close();
  }
});

test("THE TICKET TEXT IS NOT SCANNED for a motion reference", async () => {
  // THE DELIBERATE ASYMMETRY WITH `captureUrl`. A URL in the prose means "copy
  // this site" and is scanned for; wanting a page's MOVEMENT is never implied by
  // mentioning it, so this one is explicit or absent. Without this assertion the
  // route could quietly read the motion of every page any ticket cites — half a
  // minute more on a submit button, and a second reason for a ticket id to move
  // when somebody else's site does.
  const harness = await startHarness(okCapture);
  try {
    const response = await submit(harness, { ticketText: "Make a copy of https://kamilborzecki.dev" });
    const runId = ((await response.json()) as CreateRunResponse).runId;
    assert.deepEqual(harness.motionCalls, []);
    assert.deepEqual(harness.captureCalls, ["https://kamilborzecki.dev/"], "the outline capture still scans");
    assert.ok(!logLines(harness, runId).some((line) => /\bmoves\b|\bmotion\b/i.test(line.text)));
  } finally {
    await harness.close();
  }
});

test("a motionUrl that is not a string, null or absent is refused", async () => {
  const harness = await startHarness(okCapture);
  try {
    const bad = await submit(harness, { ticketText: "x", motionUrl: 7 });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_body");

    const suppressed = await submit(harness, { ticketText: "x", motionUrl: null });
    assert.equal(suppressed.status, 201, "null is the ordinary 'no motion reference'");
    assert.deepEqual(harness.motionCalls, []);
  } finally {
    await harness.close();
  }
});

test("the reading comes back on the run detail, so a panel has something to render", async () => {
  // THE FAILURE THIS PINS SHIPPED ONCE ALREADY. `references`/`documents` were
  // written into the manifest and never put on the wire, and the whole suite
  // stayed green because nothing asserted the response carried them.
  const harness = await startHarness(okCapture);
  try {
    const withMotion = await submit(harness, { ticketText: "x", motionUrl: "https://motion.example/" });
    const withMotionId = ((await withMotion.json()) as CreateRunResponse).runId;
    const detail = (await (await fetch(`${harness.base}/api/runs/${withMotionId}`)).json()) as RunDetail;
    assert.equal(detail.motion?.url, "https://motion.example/");
    assert.equal(detail.motion?.entries.length, 1);
    assert.equal(detail.motion?.entries[0]?.durationMs, 500);
    assert.equal(detail.motion?.respectsReducedMotion, true);

    // AND THE NEGATIVE CONTROL: a run with no motion reference reports `null`
    // rather than an empty spec, because "he named none" and "it read nothing"
    // are different facts and a renderer must be able to tell them apart.
    const plain = await submit(harness, { ticketText: "y" });
    const plainId = ((await plain.json()) as CreateRunResponse).runId;
    const plainDetail = (await (await fetch(`${harness.base}/api/runs/${plainId}`)).json()) as RunDetail;
    assert.equal(plainDetail.motion, null);
  } finally {
    await harness.close();
  }
});

test("a ticket with neither references nor a URL is untouched, end to end", async () => {
  // THE COMPATIBILITY CASE. Everything above adds behaviour; this asserts the
  // ordinary ticket — which is every ticket already on disk — still produces the
  // same id, the same text and no reference directory at all.
  const harness = await startHarness(okCapture);
  try {
    const text = "Build me a portfolio page with three sections";
    const response = await submit(harness, { ticketText: text });
    const runId = ((await response.json()) as CreateRunResponse).runId;
    const row = harness.store.getRun(runId);

    assert.equal(row?.ticketId, ticketFromText(text).id);
    assert.equal(row?.ticketSha256, ticketFromText(text).sha256);
    assert.equal(row?.ticketText, text);
    assert.deepEqual(harness.captureCalls, []);
    assert.equal(existsSync(referenceDirFor(harness.paths.runs, runId)), false, "no directory for no references");
    assert.equal(logLines(harness, runId).length, 0, "and nothing to say about references it does not have");
  } finally {
    await harness.close();
  }
});
