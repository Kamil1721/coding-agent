import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SUITE_MANIFEST_FILENAME } from "bakeoff/dist/scorer-protocol.js";
import { suiteRootFor } from "bakeoff/dist/spec-freeze.js";
import {
  assertArtifactExecutionReady,
  loadArtifactExecutionContract,
  type ArtifactExecutionContract,
} from "./execution-contract.js";
import { dashboardBuilderPrompt, resumeBuilderPrompt } from "./build-prompt.js";

const STATIC = { mode: "static", rootDocument: "/" } as const satisfies ArtifactExecutionContract;
const SERVER = {
  mode: "server",
  start: "node server.mjs",
  port: 7319,
  healthPath: "/ready",
} as const satisfies ArtifactExecutionContract;

function manifest(ticketId: string, execution: Record<string, unknown>): Record<string, unknown> {
  return {
    manifestVersion: 1,
    ticketId,
    target: "web",
    execution: {
      install: null,
      build: null,
      typecheck: null,
      lint: null,
      bootTimeoutMs: null,
      commandTimeoutMs: null,
      ...execution,
    },
    sourceDirs: ["."],
    uiFlows: [],
    dataExpectations: [],
  };
}

function manifestHarness(): {
  readonly root: string;
  readonly acceptance: string;
  readonly write: (ticketId: string, value: unknown) => void;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "dash-execution-contract-"));
  const acceptance = join(root, "acceptance");
  return {
    root,
    acceptance,
    write: (ticketId, value) => {
      const suite = suiteRootFor(ticketId, acceptance);
      mkdirSync(suite, { recursive: true });
      writeFileSync(join(suite, SUITE_MANIFEST_FILENAME), JSON.stringify(value), "utf8");
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the frozen parser projects only the required STATIC execution contract", () => {
  const h = manifestHarness();
  try {
    h.write("ticket-static", manifest("ticket-static", {
      start: null,
      port: null,
      healthPath: null,
    }));
    assert.deepEqual(loadArtifactExecutionContract("ticket-static", h.acceptance), STATIC);
  } finally {
    h.cleanup();
  }
});

test("the frozen parser projects only the required SERVER execution contract", () => {
  const h = manifestHarness();
  try {
    h.write("ticket-server", manifest("ticket-server", {
      start: SERVER.start,
      port: SERVER.port,
      healthPath: SERVER.healthPath,
    }));
    assert.deepEqual(loadArtifactExecutionContract("ticket-server", h.acceptance), SERVER);
  } finally {
    h.cleanup();
  }
});

test("fresh and resumed prompts share the exact narrow contract and leak no manifest canaries", () => {
  const h = manifestHarness();
  try {
    const ticketId = "manifest-ticket-canary-7f41";
    const raw = manifest(ticketId, {
      start: SERVER.start,
      port: SERVER.port,
      healthPath: SERVER.healthPath,
    });
    raw["sourceDirs"] = ["source-dir-canary-91ac"];
    h.write(ticketId, raw);
    const contract = loadArtifactExecutionContract(ticketId, h.acceptance);
    const fresh = dashboardBuilderPrompt({
      workspaceDir: join(h.root, "workspace"),
      ticketText: "build the requested app",
      allowedAgents: [],
      executionContract: contract,
    });
    const resumed = resumeBuilderPrompt("the design was locked", contract);
    for (const prompt of [fresh, resumed]) {
      assert.match(prompt, /Exact start command: "node server\.mjs"/);
      assert.match(prompt, /Exact port: 7319/);
      assert.match(prompt, /Exact health path: "\/ready"/);
      assert.doesNotMatch(prompt, /manifest-ticket-canary-7f41|source-dir-canary-91ac/);
      assert.doesNotMatch(prompt, /suite\.manifest\.json|sourceDirs|uiFlows|dataExpectations/);
    }
  } finally {
    h.cleanup();
  }
});

test("malformed, mismatched and unsupported static manifests fail closed", () => {
  const h = manifestHarness();
  try {
    h.write("malformed", { manifestVersion: 1, ticketId: "malformed" });
    assert.throws(() => loadArtifactExecutionContract("malformed", h.acceptance));

    h.write("expected", manifest("different", { start: null, port: null, healthPath: null }));
    assert.throws(() => loadArtifactExecutionContract("expected", h.acceptance), /not "expected"/);

    h.write("nested", manifest("nested", { start: null, port: null, healthPath: "/app" }));
    assert.throws(() => loadArtifactExecutionContract("nested", h.acceptance), /only the static root document/);
  } finally {
    h.cleanup();
  }
});

test("STATIC accepts a direct non-empty regular root index", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dash-static-ready-"));
  try {
    writeFileSync(join(workspace, "index.html"), "<!doctype html><title>ready</title>", "utf8");
    assert.doesNotThrow(() => assertArtifactExecutionReady(workspace, STATIC));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("STATIC rejects missing, whitespace-only and symlink root indexes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dash-static-red-"));
  try {
    assert.throws(() => assertArtifactExecutionReady(workspace, STATIC), /index\.html/);
    writeFileSync(join(workspace, "index.html"), " \n\t", "utf8");
    assert.throws(() => assertArtifactExecutionReady(workspace, STATIC), /non-empty/);
    rmSync(join(workspace, "index.html"));
    writeFileSync(join(workspace, "other.html"), "real content", "utf8");
    symlinkSync("other.html", join(workspace, "index.html"));
    assert.throws(() => assertArtifactExecutionReady(workspace, STATIC), /symlink/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("STATIC scans a large whitespace document in bounded chunks and closes its descriptor", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dash-static-large-"));
  const index = join(workspace, "index.html");
  try {
    writeFileSync(index, Buffer.alloc(8 * 1024 * 1024, 0x20));
    assert.throws(() => assertArtifactExecutionReady(workspace, STATIC), /non-empty/);

    // Replacing the file immediately after the refusal is also a practical
    // assertion that the descriptor was closed on the throwing path.
    rmSync(index);
    writeFileSync(index, Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 0x20), Buffer.from("<html>")]));
    assert.doesNotThrow(() => assertArtifactExecutionReady(workspace, STATIC));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("STATIC rejects a FIFO without blocking before descriptor classification", (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo and O_NONBLOCK FIFO semantics are POSIX-only");
    return;
  }
  const workspace = mkdtempSync(join(tmpdir(), "dash-static-fifo-"));
  try {
    try {
      execFileSync("mkfifo", [join(workspace, "index.html")]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOSYS" || code === "ENOTSUP") {
        t.skip(`mkfifo is unsupported: ${code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => assertArtifactExecutionReady(workspace, STATIC),
      /index\.html/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("STATIC does not infer SERVER mode from package.json or server source", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dash-static-negative-"));
  try {
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { start: "node server.mjs" } }), "utf8");
    writeFileSync(join(workspace, "server.mjs"), "export const ready = true;", "utf8");
    assert.throws(() => assertArtifactExecutionReady(workspace, STATIC), /index\.html/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("SERVER remains SERVER and proceeds without a speculative duplicate boot", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dash-server-ready-"));
  try {
    assert.doesNotThrow(() => assertArtifactExecutionReady(workspace, SERVER));
    assert.deepEqual(SERVER, {
      mode: "server",
      start: "node server.mjs",
      port: 7319,
      healthPath: "/ready",
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
