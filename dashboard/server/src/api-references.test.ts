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

import type { CreateRunResponse, SseEvent } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { HttpDeps, RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import type { SiteCapture, SiteCaptureResult } from "./site-capture.js";
import { readReferenceManifest, referenceDirFor } from "./ticket-refs.js";
import { ticketFromText } from "./ticket.js";

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

interface Harness {
  readonly base: string;
  readonly store: RunStore;
  readonly paths: DashboardPaths;
  /** Every URL the route asked to capture. Empty means it never tried. */
  readonly captureCalls: string[];
  close(): Promise<void>;
}

async function startHarness(
  capture: (url: string) => SiteCaptureResult | Promise<SiteCaptureResult>,
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

  const deps: HttpDeps = {
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
    captureSite: async (options) => {
      captureCalls.push(options.url);
      return await capture(options.url);
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
