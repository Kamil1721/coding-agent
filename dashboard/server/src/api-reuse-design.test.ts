/**
 * api-reuse-design.test.ts — `POST /api/runs` with `reuseDesignFrom`, over a real
 * loopback server.
 *
 * A SEPARATE FILE FROM `api.test.ts` AND FROM `api-references.test.ts`, for the
 * reason the second of those states about the first: this file owns ONE concern —
 * what the create-run route does with a request that asks to build against another
 * run's design — and carries its own trimmed harness rather than widening a
 * frozen contract's test.
 *
 * ─── THE ASSERTION THIS FILE EXISTS FOR ───
 *
 * A REFUSED SUBMISSION MINTS NO RUN AND WRITES NO DIRECTORY. `createRun`'s own
 * intake comments state that invariant for the reference and document decoders
 * ("the run id below is minted after this point, so a refusal here costs no
 * directory and no row"), and the four reuse refusals have to hold it too — they
 * are the only refusals in the route that read another run's directory, which is
 * precisely the kind of check that tends to get placed after the id is minted
 * because that is where the paths are convenient.
 *
 * Every refusal test therefore counts the rows AND the directories on both sides
 * of the request, and every one of them ends by submitting the SAME body with a
 * VALID source and asserting a 201 — a route that refused everything would satisfy
 * the first half of each test.
 *
 * ─── THE ORCHESTRATOR IS STUBBED ───
 *
 * `pump()` does nothing here, so no run executes and no design is copied: this
 * file is about the ROUTE's decisions. What the orchestrator does with the marker
 * is measured in `orchestrator.design-reuse.test.ts`, against a real orchestrator.
 * The two are deliberately not allowed to launder each other's coverage.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import type { ApiErrorResponse, CreateRunResponse, SseEvent } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { manifestPathFor, refsDirFor } from "./design-manifest.js";
import { writeReusableDesign } from "./design-reuse-fixture.js";
import { DESIGN_REUSE_MARKER_FILE, readDesignReuseMarker } from "./design-reuse.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { HttpDeps, RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths, runPathsFor } from "./paths.js";

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

/** The run whose design is lendable. The id is the measured run's own. */
const SOURCE_RUN_ID = "run-2026-08-12T09-00-35-066Z-6ec44b2f";

const TICKET = "Build me a portfolio page with a considered visual design";

interface Harness {
  readonly base: string;
  readonly store: RunStore;
  readonly paths: DashboardPaths;
  /** The source run's paths, with a complete locked design already on disk. */
  readonly source: ReturnType<typeof runPathsFor>;
  /** Every run directory that exists right now. */
  runDirs(): readonly string[];
  runRows(): number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-reuse-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  // A LOGGED-IN CLAUDE STUB, because the catalog emits no rows without a real
  // login and every submission below would 409 before reaching the code this file
  // is about. Same shape as `api-references.test.ts`'s harness.
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

  const source = runPathsFor(paths, SOURCE_RUN_ID);
  writeReusableDesign(source);

  const deps: HttpDeps = {
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
    // NEVER THE NETWORK. No ticket below carries a URL, so neither seam should
    // fire at all; they are stubbed so that a regression which started scanning
    // for one fails loudly here rather than launching a browser.
    captureSite: async () => ({ ok: false, reason: "no capture in a reuse routing test" }),
    captureMotion: async () => ({ ok: false, reason: "no motion in a reuse routing test" }),
  };
  const server = createDashboardServer(deps);
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    store,
    paths,
    source,
    runDirs: () => readdirSync(paths.runs).sort(),
    runRows: () => store.listRuns().length,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function submit(harness: Harness, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${harness.base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: "opus[1m]", ticketText: TICKET, ...body }),
  });
}

/**
 * Submit a body expected to be REFUSED, and check the two things a refusal must
 * cost nothing: a row and a directory.
 */
async function refused(harness: Harness, body: Record<string, unknown>, code: string): Promise<ApiErrorResponse> {
  const dirsBefore = harness.runDirs();
  const rowsBefore = harness.runRows();
  const response = await submit(harness, body);
  assert.equal(response.status, 400, `expected a 400 for ${code}`);
  const error = (await response.json()) as ApiErrorResponse;
  assert.equal(error.error, code);
  assert.deepEqual(
    harness.runDirs(),
    dirsBefore,
    `${code} minted a run DIRECTORY. A refusal above the mint is the whole invariant: it must cost no ` +
      "directory, no row, no capture and no spec phase.",
  );
  assert.equal(harness.runRows(), rowsBefore, `${code} minted a run ROW`);
  return error;
}

function logLines(harness: Harness, runId: string): readonly string[] {
  return harness.store
    .eventsSince(runId, 0)
    .map((stored) => stored.event as SseEvent)
    .filter((event): event is Extract<SseEvent, { type: "log" }> => event.type === "log")
    .map((event) => event.text);
}

/* -------------------------------------------------------------------------
 * The accepted arm
 * ---------------------------------------------------------------------- */

test("a valid reuseDesignFrom is accepted and leaves the intent in the run's own directory", async () => {
  const harness = await startHarness();
  try {
    const response = await submit(harness, { reuseDesignFrom: SOURCE_RUN_ID });
    assert.equal(response.status, 201);
    const { runId } = (await response.json()) as CreateRunResponse;
    assert.notEqual(harness.store.getRun(runId), null, "the run is real and queued");

    const marker = readDesignReuseMarker(runPathsFor(harness.paths, runId).root);
    assert.equal(marker?.sourceRunId, SOURCE_RUN_ID, "the orchestrator reads this file and nothing else");
    assert.notEqual(marker?.requestedAt, "", "the intent records WHEN it was asked for");

    // NOTHING IS COPIED AT INTAKE. The workspace does not exist yet — the copy
    // belongs to the orchestrator, after `#prepareWorkspace` — and a POST that
    // copied eleven files would also charge a submission for a run that may be
    // cancelled before it ever builds.
    assert.equal(
      existsSync(refsDirFor(runPathsFor(harness.paths, runId).workspace)),
      false,
      "the intake must not create a design-refs directory",
    );

    const lines = logLines(harness, runId);
    assert.ok(
      lines.some((line) => line.includes("REUSE") && line.includes(SOURCE_RUN_ID)),
      `the run's own stream must say which run the art will come from; got ${JSON.stringify(lines)}`,
    );
  } finally {
    await harness.close();
  }
});

test("THE NEGATIVE CONTROL: a submission with no reuseDesignFrom writes no marker at all", async () => {
  // Without this, every assertion in this file is satisfied by a route that
  // marks EVERY run as reusing something.
  const harness = await startHarness();
  try {
    for (const body of [{}, { reuseDesignFrom: null }]) {
      const response = await submit(harness, body);
      assert.equal(response.status, 201);
      const { runId } = (await response.json()) as CreateRunResponse;
      const root = runPathsFor(harness.paths, runId).root;
      assert.equal(readDesignReuseMarker(root), null, `${JSON.stringify(body)} must not mark the run as reusing`);
      assert.equal(existsSync(join(root, DESIGN_REUSE_MARKER_FILE)), false);
      assert.ok(
        !logLines(harness, runId).some((line) => line.includes("REUSE")),
        "a run that generates its own design must not claim to have reused one",
      );
    }
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The four refusals — each fires on its own broken source, and NOT on the good
 * one. The 201 at the end of each test is the control.
 * ---------------------------------------------------------------------- */

test("REFUSAL: a run id that names no directory on disk", async () => {
  const harness = await startHarness();
  try {
    const error = await refused(harness, { reuseDesignFrom: "run-nobody-ever-made" }, "reuse_source_missing");
    assert.match(error.message, /run-nobody-ever-made/, "the refusal names the id it was given");
    assert.equal((await submit(harness, { reuseDesignFrom: SOURCE_RUN_ID })).status, 201, "the control");
  } finally {
    await harness.close();
  }
});

test("REFUSAL: a source whose lane never wrote design-refs/", async () => {
  const harness = await startHarness();
  try {
    rmSync(refsDirFor(harness.source.workspace), { recursive: true, force: true });
    await refused(harness, { reuseDesignFrom: SOURCE_RUN_ID }, "reuse_source_no_design_refs");
    // THE CONTROL, RESTORED. The same id is accepted the moment the directory is
    // back, so the refusal was the directory and not the id.
    writeReusableDesign(harness.source);
    assert.equal((await submit(harness, { reuseDesignFrom: SOURCE_RUN_ID })).status, 201);
  } finally {
    await harness.close();
  }
});

test("REFUSAL: a design-refs directory with no manifest.json", async () => {
  const harness = await startHarness();
  try {
    rmSync(manifestPathFor(harness.source.workspace));
    await refused(harness, { reuseDesignFrom: SOURCE_RUN_ID }, "reuse_source_no_manifest");
    writeReusableDesign(harness.source);
    assert.equal((await submit(harness, { reuseDesignFrom: SOURCE_RUN_ID })).status, 201);
  } finally {
    await harness.close();
  }
});

test("REFUSAL: a source that settled no design lock", async () => {
  const harness = await startHarness();
  try {
    // The locked still, deleted. It passes every null check — the manifest and the
    // record both still NAME it — and is the shape that would otherwise reach the
    // gate as a missing reference.
    const locked = readFileSync(manifestPathFor(harness.source.workspace), "utf8");
    const lockedPath = String((JSON.parse(locked) as { locked: string }).locked);
    rmSync(lockedPath);
    const error = await refused(harness, { reuseDesignFrom: SOURCE_RUN_ID }, "reuse_source_no_lock");
    assert.match(error.message, /not on disk/);
    writeReusableDesign(harness.source);
    assert.equal((await submit(harness, { reuseDesignFrom: SOURCE_RUN_ID })).status, 201);
  } finally {
    await harness.close();
  }
});

test("REFUSAL: reuseDesignFrom that is not a run id at all", async () => {
  const harness = await startHarness();
  try {
    for (const value of [42, "", "   ", ["run-x"], {}]) {
      await refused(harness, { reuseDesignFrom: value }, "invalid_body");
    }
    assert.equal((await submit(harness, { reuseDesignFrom: SOURCE_RUN_ID })).status, 201, "the control");
  } finally {
    await harness.close();
  }
});

test("the source run's STATUS is not what is checked — a run with no row still lends its design", async () => {
  // The source fixture has a DIRECTORY and no database row at all: nothing in this
  // harness ever called `createRun` for it. It is accepted, which is the point —
  // the question the route asks is "is there a complete design set on disk", and a
  // check that consulted the row would refuse this and accept a `completed` run
  // whose lane was degraded and wrote nothing.
  const harness = await startHarness();
  try {
    assert.equal(harness.store.getRun(SOURCE_RUN_ID), null, "the precondition: the source has no row");
    assert.equal((await submit(harness, { reuseDesignFrom: SOURCE_RUN_ID })).status, 201);
  } finally {
    await harness.close();
  }
});
