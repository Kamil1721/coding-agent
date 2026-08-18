/**
 * api-machine-checks.test.ts — the twelve gates ON THE WIRE, over a real
 * loopback server.
 *
 * A SEPARATE FILE FROM `machine-checks.test.ts` AND FROM `api.test.ts`, for the
 * reason `api-references.test.ts` states about itself: that file owns the frozen
 * contract, this one owns a single question — does `GET /api/runs/:id` actually
 * carry the machine checks, and does it carry the ABSENCE correctly.
 *
 * WHY IT IS NOT ENOUGH TO TEST THE COMPOSER. `machine-checks.test.ts` proves
 * `readMachineChecks` returns the right twelve rows; it says nothing about
 * whether `toDetail` calls it, and `toDetail` is not exported. A field that is
 * composed perfectly and never attached to the response is exactly the failure
 * `contract-parity.test.ts`'s header records for `references`/`documents`: two
 * green typechecks, a serialised body, and nothing on the owner's screen. The
 * only check that can see it is one that reads the response.
 *
 * THE ORCHESTRATOR IS STUBBED. Starting a real run spawns a builder subprocess
 * and spends the owner's quota; nothing here needs one, because the score record
 * this route reads is a file on disk and the test writes it.
 *
 * THE NEGATIVE CONTROL, applied to `http.ts`, watched, reverted (the file was
 * diffed byte-identical afterwards): `toDetail`'s `machineChecks` made to serve
 * `null` unconditionally, which is a route that composes the field and throws
 * the answer away. This test went RED; all eight tests in
 * `machine-checks.test.ts` stayed GREEN. That is the discrimination the file
 * exists for, measured rather than asserted.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ALL_GATE_IDS, GATE_IDS } from "bakeoff/dist/scorer-protocol.js";

import type { CreateRunResponse, RunDetail } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { scoresRoot } from "./gate-attempts.js";
import { GateProbe } from "./health-gate.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { HttpDeps, RunController } from "./http.js";
import { MACHINE_CHECK_LABELS } from "./machine-checks.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths } from "./paths.js";

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

interface Harness {
  readonly base: string;
  readonly paths: DashboardPaths;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-machine-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  // A logged-in stub, because `ModelCatalog` lists nothing without one and every
  // submission would 409 before reaching the route under test. A throwaway
  // executable, so the real `execFile` probe runs rather than a mock of it.
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
  const deps: HttpDeps = {
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
  };
  const server = createDashboardServer(deps);
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    paths,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function submit(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: "opus[1m]", ticketText: "Build me a portfolio page" }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as CreateRunResponse).runId;
}

async function detail(harness: Harness, runId: string): Promise<RunDetail> {
  const response = await fetch(`${harness.base}/api/runs/${runId}`);
  assert.equal(response.status, 200);
  return (await response.json()) as RunDetail;
}

/** The score record the scorer writes, reduced to the fields the route reads. */
function writeScoreRecord(
  paths: DashboardPaths,
  runId: string,
  gates: readonly { readonly id: string; readonly passed: boolean; readonly detail?: string }[],
): void {
  mkdirSync(scoresRoot(paths), { recursive: true });
  writeFileSync(
    join(scoresRoot(paths), `${runId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      heldOutPass: gates.every((gate) => gate.passed),
      criteriaResults: gates.map((gate) => ({
        criterionId: gate.id,
        tier: "BLOCKING",
        passed: gate.passed,
        evidenceRef: null,
        detail: gate.detail ?? null,
      })),
    }),
    "utf8",
  );
}

test("THE WIRE CARRIES THE MACHINE CHECKS: GET /api/runs/:id serves all twelve, in the owner's words", async () => {
  const harness = await startHarness();
  try {
    const runId = await submit(harness);

    // BEFORE THE GATE: the field is present and it is `null`. Present matters —
    // an absent key and a null both read as "no data" to a renderer, but only
    // one of them proves the route composed the field at all.
    const beforeBody = (await detail(harness, runId)) as unknown as Record<string, unknown>;
    assert.ok("machineChecks" in beforeBody, "the response does not carry the field at all");
    assert.equal(beforeBody["machineChecks"], null, "a run that has not been gated must report null");

    writeScoreRecord(harness.paths, runId, [
      ...ALL_GATE_IDS.filter((id) => id !== GATE_IDS.build && id !== GATE_IDS.suiteGreen).map((id) => ({
        id,
        passed: true,
      })),
      { id: GATE_IDS.build, passed: false, detail: "next build exited 1: Type error in app/page.tsx" },
      {
        id: GATE_IDS.suiteGreen,
        passed: false,
        detail: "node-test: exit 1; holdout/coglane.test.mjs › [REQ-001] the root document answers 200",
      },
    ]);

    const after = await detail(harness, runId);
    const checks = after.machineChecks;
    assert.notEqual(checks, null, "the score record is on disk and the route did not read it");
    assert.deepEqual(
      checks?.map((check) => check.id),
      [...ALL_GATE_IDS],
      "the wire must carry every gate, in one order",
    );
    assert.deepEqual(
      checks?.filter((check) => !check.passed).map((check) => check.id),
      [GATE_IDS.build, GATE_IDS.suiteGreen],
      "exactly the two failures written above, and in ALL_GATE_IDS order",
    );

    // THE LABEL IS THE SERVER'S, COMPOSED ONCE. A client that had to spell these
    // itself is how two surfaces end up naming one gate two ways.
    assert.equal(
      checks?.find((check) => check.id === GATE_IDS.build)?.label,
      MACHINE_CHECK_LABELS[GATE_IDS.build],
    );

    // THE ALLOWLIST HOLDS ACROSS THE ROUTE, not just inside the composer.
    assert.equal(
      checks?.find((check) => check.id === GATE_IDS.build)?.detail,
      "next build exited 1: Type error in app/page.tsx",
    );
    assert.equal(
      checks?.find((check) => check.id === GATE_IDS.suiteGreen)?.detail,
      null,
      "this gate's detail quotes the held-out runner and must not reach the browser",
    );
    assert.doesNotMatch(
      JSON.stringify(checks),
      /holdout\//,
      "a held-out test path was serialised into the run detail response",
    );
  } finally {
    await harness.close();
  }
});
