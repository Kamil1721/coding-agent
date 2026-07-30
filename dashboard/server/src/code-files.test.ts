/**
 * code-files.test.ts — `GET /api/runs/:id/files`, over a real loopback server,
 * with a real workspace on disk and a real sealed suite three levels above it.
 *
 * EVERY REFUSAL HERE IS PAIRED WITH A POSITIVE CONTROL IN THE SAME TEST, and
 * that pairing is the only thing separating this file from a suite that would
 * stay green if the route were `return 403` for everything. The refusals prove a
 * traversal is stopped; `visible-acceptance/coglane-page.spec.mjs` coming back
 * 200 with its real bytes proves the fence is a fence and not a wall.
 *
 * THE GEOMETRY IS THE POINT OF THE FIXTURE. The workspace is
 * `<home>/runs/<id>/workspace`; the SEALED store is `<home>/acceptance`, which is
 * `../../../acceptance` from inside it, and `<home>/results/scores`, which is
 * `../../../results/scores`. Both carry held-out test titles verbatim — `scores`
 * was found leaking exactly that earlier today — so each escape test asserts not
 * merely a non-200 status but that the held-out marker string appears NOWHERE in
 * the response body. A 500 from an unhandled `ENOENT` would satisfy "not 200"
 * and prove nothing.
 *
 * THE REDACTION FIXTURE IS VERIFIED BEFORE IT IS TRUSTED. `LEAKED_KEY` is
 * checked with `assertRedacted` in its own test, so a fixture that matched no
 * rule — which would make the redaction assertion pass with
 * `redactForPersistence` deleted — is itself a failure. It deliberately matches a
 * PATTERN rule (`ANTHROPIC_KEY_SHAPE`) rather than relying on
 * `DEFAULT_KNOWN_ENV_NAMES`: that pass only fires when the variable is set in
 * this process, so a known-value fixture would go green in an empty environment
 * no matter what the route did.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRedacted } from "bakeoff/dist/redact.js";
import type { ApiErrorResponse, CodeFileResponse, CodeTreeResponse } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import {
  MAX_FILE_BYTES,
  MAX_PATH_CHARS,
  MAX_TREE_ENTRIES,
  denyReason,
  pathRefusal,
  readWorkspaceTree,
} from "./code-files.js";
import { RunStore } from "./db.js";
import { createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, ensureRunDirs, resolvePaths, runPathsFor } from "./paths.js";

const RUN_ID = "run-code-fixture";
const EMPTY_RUN_ID = "run-no-workspace";

/**
 * The string that must never cross the wire. It stands in for a held-out test
 * title, which is what `dashboard/acceptance` and `results/scores` really hold.
 */
const HELD_OUT_MARKER = "HELD_OUT_TITLE:the booking modal closes on Escape";

/** Proof that a legitimate read really did reach the file. */
const VISIBLE_MARKER = "VISIBLE_SUBSET_MARKER:renders the hero";

/**
 * Matches `ANTHROPIC_KEY_SHAPE` in `bakeoff/src/redact.ts`. Not a real key: the
 * shape is what the rule tests, and the shape is all this fixture needs.
 */
const LEAKED_KEY = "sk-ant-api03-Zq9WfTb2Kx4Lm8Np1Qr7Sv3Uw6Yz0Ab5Cd8Ef2Gh4Ij6Kl";

/** The last bytes of the oversized file. Present on disk, absent from the wire. */
const TAIL_MARKER = "TAIL_BYTES_BEYOND_THE_CAP";

interface Harness {
  readonly base: string;
  readonly paths: DashboardPaths;
  readonly workspace: string;
  close(): Promise<void>;
}

function writeFixtureFile(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-code-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  // SEALED, and OUTSIDE the workspace. Three levels up from it, which is the
  // distance every escape test below has to cover.
  mkdirSync(paths.acceptance, { recursive: true });
  writeFixtureFile(join(paths.acceptance, "held-out-titles.md"), `# suite\n\n- ${HELD_OUT_MARKER}\n`);
  mkdirSync(join(paths.results, "scores"), { recursive: true });
  writeFixtureFile(
    join(paths.results, "scores", "run.json"),
    JSON.stringify({ titles: [HELD_OUT_MARKER] }, null, 2),
  );

  const runPaths = runPathsFor(paths, RUN_ID);
  ensureRunDirs(runPaths);
  const workspace = runPaths.workspace;

  writeFixtureFile(join(workspace, "index.html"), "<h1>Coglane</h1>\n");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFixtureFile(join(workspace, "src", "app.js"), "export const ok = true;\n");

  // THE VISIBLE SUBSET. Inside the workspace, deliberately readable.
  mkdirSync(join(workspace, "visible-acceptance"), { recursive: true });
  writeFixtureFile(
    join(workspace, "visible-acceptance", "coglane-page.spec.mjs"),
    `// ${VISIBLE_MARKER}\nexport default 1;\n`,
  );

  // Credential files. Both are reachable by name if `denyReason` is not called
  // on the content branch, which is exactly what two of the tests below check.
  writeFixtureFile(join(workspace, ".env"), `ANTHROPIC_API_KEY=${LEAKED_KEY}\n`);
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFixtureFile(
    join(workspace, ".git", "config"),
    '[remote "origin"]\n\turl = https://someone:hunter2hunter2@github.com/o/p.git\n',
  );

  // A key committed into ordinary source by a build agent.
  writeFixtureFile(join(workspace, "leaky.js"), `const key = "${LEAKED_KEY}";\nexport default key;\n`);

  // Binary: a NUL in the sniff window.
  mkdirSync(join(workspace, "assets"), { recursive: true });
  writeFileSync(join(workspace, "assets", "pic.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x00, 0x42]));

  // Larger than the cap, with a marker in the part that must not ship.
  writeFixtureFile(join(workspace, "big.txt"), `${"a".repeat(MAX_FILE_BYTES + 2_048)}${TAIL_MARKER}`);

  // A symlink out of the workspace, into the sealed store.
  symlinkSync(join(paths.acceptance, "held-out-titles.md"), join(workspace, "escape.txt"));

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  for (const runId of [RUN_ID, EMPTY_RUN_ID]) {
    store.createRun({
      runId,
      ticketId: "t-1",
      ticketTitle: "A workshop landing page",
      ticketText: "Build it.",
      ticketSha256: "0".repeat(64),
      modelId: "opus[1m]",
      provider: "anthropic",
      deploy: false,
      startedAt: new Date().toISOString(),
      queuePosition: 1,
    });
  }

  // Never invoked: no test here touches /api/health or /api/models. The real
  // classes are constructed rather than mocked so this file exercises the same
  // router wiring `index.ts` builds.
  const claudeBin = join(dir, "claude-stub");
  writeFileSync(claudeBin, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(claudeBin, 0o755);
  const auth = new AuthProbe({ claudeBin, codexBin: claudeBin, env: {} });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: () => false,
    resume: () => false,
    pushLiveMessage: () => false,
  };

  const server = createDashboardServer({ store, bus, orchestrator, catalog, auth, paths });
  await new Promise<void>((done) => {
    server.listen({ host: "127.0.0.1", port: 0 }, () => done());
  });
  const address = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    paths,
    workspace,
    close: async (): Promise<void> => {
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The raw body as well as the parsed one: a leak test must read the bytes. */
async function ask(
  harness: Harness,
  query: string,
  runId: string = RUN_ID,
): Promise<{ status: number; raw: string; body: unknown }> {
  const response = await fetch(`${harness.base}/api/runs/${runId}/files${query}`);
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: response.status, raw, body };
}

/* -------------------------------------------------------------------------
 * Pure predicates
 * ---------------------------------------------------------------------- */

test("pathRefusal REJECTS a traversal rather than repairing it", () => {
  // The failure this replaces: `safeSegment("../../etc/passwd")` returns
  // `.._.._etc_passwd`, a legal filename that 404s. The refusal has to be a
  // refusal, and it has to name the segment.
  for (const bad of ["../x", "a/../../b", "..", "./x", "a//b", "", "\0", "a\\b", "/etc/passwd"]) {
    const refusal = pathRefusal(bad);
    assert.notEqual(refusal, null, `expected ${JSON.stringify(bad)} to be refused`);
    assert.ok(refusal !== null && refusal.status >= 400, "a refusal carries a 4xx status");
  }
  assert.equal(pathRefusal("x".repeat(MAX_PATH_CHARS + 1))?.code, "invalid_path");

  // POSITIVE CONTROL: the shapes the tree actually produces must pass.
  for (const good of ["index.html", "visible-acceptance/coglane-page.spec.mjs", "a/b/c.txt", ".claude/x"]) {
    assert.equal(pathRefusal(good), null, `expected ${JSON.stringify(good)} to be accepted`);
  }
});

test("denyReason names credential files and non-source directories, and nothing else", () => {
  for (const bad of [
    ".env",
    ".env.local",
    "production.env",
    "id_rsa",
    "id_ed25519.pub",
    "server.pem",
    "app.key",
    "key.p12",
    ".npmrc",
    ".netrc",
    ".ssh/config",
    "secrets.json",
    "credentials",
    ".git/config",
    "node_modules/left-pad/index.js",
  ]) {
    assert.notEqual(denyReason(bad), null, `expected ${bad} to be denied`);
  }
  // POSITIVE CONTROL. Over-blocking hides the code the panel exists to show:
  // `tokens.ts` is a real file in this package and `visible-acceptance/` is the
  // subset the builder was given.
  for (const good of [
    "index.html",
    "src/app.js",
    "tokens.ts",
    "token-usage.ts",
    "visible-acceptance/coglane-page.spec.mjs",
    ".claude/settings.json",
    "design-refs/manifest.json",
    "environment.md",
  ]) {
    assert.equal(denyReason(good), null, `expected ${good} to be allowed, got ${String(denyReason(good))}`);
  }
});

test("the redaction fixture really does match a credential rule", () => {
  // WITHOUT THIS, the redaction test below would pass with
  // `redactForPersistence` deleted from the route: a fixture no rule matches
  // produces no placeholder and no assertion can tell.
  assert.throws(() => assertRedacted(`const key = "${LEAKED_KEY}";`), /ANTHROPIC_KEY_SHAPE/);
});

/* -------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------- */

test("the tree lists the workspace, and says what it left out", async () => {
  const harness = await startHarness();
  try {
    const { status, body } = await ask(harness, "");
    assert.equal(status, 200);
    const tree = body as CodeTreeResponse;
    assert.equal(tree.kind, "tree");
    assert.equal(tree.truncated, false);

    const paths = tree.entries.map((entry) => entry.path);
    for (const expected of [
      "index.html",
      "src",
      "src/app.js",
      "visible-acceptance",
      "visible-acceptance/coglane-page.spec.mjs",
      "assets/pic.jpg",
      "big.txt",
      "leaky.js",
    ]) {
      assert.ok(paths.includes(expected), `tree is missing ${expected}: ${paths.join(", ")}`);
    }

    // Neither credential store is listed, and neither omission is silent.
    assert.ok(!paths.includes(".env"), ".env must not be listed");
    assert.ok(!paths.some((path) => path.startsWith(".git")), ".git must not be walked");
    const excluded = new Map(tree.exclusions.map((one) => [one.path, one.reason]));
    assert.match(excluded.get(".env") ?? "", /credential file by name/);
    assert.match(excluded.get(".git") ?? "", /git directory is not source/);
    assert.match(excluded.get("escape.txt") ?? "", /symlink/);

    // Sizes, because the UI reports "showing 256 KB of N".
    const big = tree.entries.find((entry) => entry.path === "big.txt");
    assert.ok(big !== undefined && big.bytes !== null && big.bytes > MAX_FILE_BYTES);
    const dir = tree.entries.find((entry) => entry.path === "src");
    assert.equal(dir?.bytes, null, "a directory has no size");
  } finally {
    await harness.close();
  }
});

test("THE HELD-OUT BOUNDARY: the visible subset is served and the sealed store is not", async () => {
  const harness = await startHarness();
  try {
    // POSITIVE CONTROL FIRST. Without it, every refusal below is satisfied by a
    // route that serves nothing at all.
    const visible = await ask(harness, "?path=visible-acceptance/coglane-page.spec.mjs");
    assert.equal(visible.status, 200, visible.raw.slice(0, 200));
    const file = visible.body as CodeFileResponse;
    assert.equal(file.kind, "file");
    assert.ok(file.text !== null && file.text.includes(VISIBLE_MARKER), "the visible subset must be readable");

    // THE ESCAPES. `runs/<id>/workspace` -> `<home>/acceptance` is three levels.
    const escapes = [
      "?path=../../../acceptance/held-out-titles.md",
      "?path=../../../results/scores/run.json",
      // Percent-encoded: `searchParams` decodes once, so this arrives as `../`
      // and must be refused on shape.
      "?path=%2e%2e%2f%2e%2e%2f%2e%2e%2facceptance%2fheld-out-titles.md",
      "?path=%2E%2E/%2E%2E/%2E%2E/acceptance/held-out-titles.md",
      // Double-encoded: this must NOT be decoded twice. It arrives as one long
      // literal segment and is simply absent.
      "?path=%252e%252e%252f%252e%252e%252f%252e%252e%252facceptance%252fheld-out-titles.md",
      // A symlink inside the workspace pointing at the sealed store.
      "?path=escape.txt",
      // Absolute.
      `?path=${encodeURIComponent(join(harness.paths.acceptance, "held-out-titles.md"))}`,
    ];
    for (const query of escapes) {
      const attempt = await ask(harness, query);
      // THE LEAK ASSERTION IS FIRST ON PURPOSE. Both must hold, but a served
      // held-out title is the worse failure by a distance, and whichever
      // assertion fires first is the one a reader of the red output sees.
      assert.ok(
        !attempt.raw.includes(HELD_OUT_MARKER),
        `${query} leaked a held-out title: ${attempt.raw.slice(0, 300)}`,
      );
      assert.notEqual(attempt.status, 200, `${query} must not be served`);
      // A 500 would also satisfy "not 200" and would prove nothing about the
      // check, so the status is pinned to the deliberate refusals.
      assert.ok(
        [400, 403, 404].includes(attempt.status),
        `${query} answered ${String(attempt.status)}; expected a deliberate refusal, not a crash`,
      );
    }
  } finally {
    await harness.close();
  }
});

test("a credential file is refused on the CONTENT branch, not merely hidden from the tree", async () => {
  const harness = await startHarness();
  try {
    for (const path of [".env", ".git/config", "node_modules/x/index.js"]) {
      const attempt = await ask(harness, `?path=${encodeURIComponent(path)}`);
      assert.equal(attempt.status, 403, `${path} answered ${String(attempt.status)}`);
      assert.equal((attempt.body as ApiErrorResponse).error, "path_forbidden");
      assert.ok(!attempt.raw.includes(LEAKED_KEY), `${path} leaked a key`);
      assert.ok(!attempt.raw.includes("hunter2hunter2"), `${path} leaked a git remote credential`);
    }
    // POSITIVE CONTROL: an ordinary file at the same depth is served.
    const ok = await ask(harness, "?path=src/app.js");
    assert.equal(ok.status, 200);
    assert.match((ok.body as CodeFileResponse).text ?? "", /export const ok/);
  } finally {
    await harness.close();
  }
});

test("a key committed into source is redacted on its way to the browser", async () => {
  const harness = await startHarness();
  try {
    const { status, raw, body } = await ask(harness, "?path=leaky.js");
    assert.equal(status, 200);
    const file = body as CodeFileResponse;
    assert.ok(!raw.includes(LEAKED_KEY), "the response body still carries the key");
    assert.ok(file.text !== null && file.text.includes("[REDACTED:"), "no placeholder in the served text");
    assert.ok(file.redactions >= 1, "the redaction count must say something happened");
    assert.equal(file.withheld, null);
    // The rest of the file survives: redaction must not blank the source.
    assert.match(file.text, /export default key/);
  } finally {
    await harness.close();
  }
});

test("a file over the cap is truncated AND says so", async () => {
  const harness = await startHarness();
  try {
    const { status, raw, body } = await ask(harness, "?path=big.txt");
    assert.equal(status, 200);
    const file = body as CodeFileResponse;
    assert.equal(file.truncated, true, "truncation must be reported, not silent");
    assert.equal(file.text?.length, MAX_FILE_BYTES);
    assert.ok(file.bytes > MAX_FILE_BYTES, "`bytes` is the size on disk, so the UI can say how much is missing");
    assert.ok(!raw.includes(TAIL_MARKER), "bytes past the cap reached the wire");

    // POSITIVE CONTROL: a small file is NOT flagged as truncated.
    const small = await ask(harness, "?path=index.html");
    assert.equal((small.body as CodeFileResponse).truncated, false);
  } finally {
    await harness.close();
  }
});

test("binary bytes are reported as binary rather than rendered as mojibake", async () => {
  const harness = await startHarness();
  try {
    const { status, body } = await ask(harness, "?path=assets/pic.jpg");
    assert.equal(status, 200);
    const file = body as CodeFileResponse;
    assert.equal(file.binary, true);
    assert.equal(file.text, null);
    assert.ok(file.bytes > 0);

    // POSITIVE CONTROL: text is not mistaken for binary.
    const text = await ask(harness, "?path=index.html");
    assert.equal((text.body as CodeFileResponse).binary, false);
  } finally {
    await harness.close();
  }
});

test("the tree cap is a cap and reports itself", () => {
  // NOT OVER HTTP: this needs 1,600 files, and the only thing under test is the
  // walk's own bound. The route has no separate opinion about it.
  const dir = mkdtempSync(join(tmpdir(), "dash-code-wide-"));
  try {
    for (let index = 0; index < MAX_TREE_ENTRIES + 100; index += 1) {
      writeFixtureFile(join(dir, `f${String(index).padStart(5, "0")}.txt`), "x");
    }
    const tree = readWorkspaceTree(dir, RUN_ID) as CodeTreeResponse;
    assert.equal(tree.kind, "tree");
    assert.equal(tree.truncated, true, "hitting the cap must be reported, not silent");
    assert.equal(tree.entries.length, MAX_TREE_ENTRIES);

    // POSITIVE CONTROL: one file under the cap is not flagged.
    const small = mkdtempSync(join(tmpdir(), "dash-code-small-"));
    try {
      writeFixtureFile(join(small, "only.txt"), "x");
      const one = readWorkspaceTree(small, RUN_ID) as CodeTreeResponse;
      assert.equal(one.truncated, false);
      assert.equal(one.entries.length, 1);
    } finally {
      rmSync(small, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory, a missing file and a run with no workspace each get a named refusal", async () => {
  const harness = await startHarness();
  try {
    const dir = await ask(harness, "?path=src");
    assert.equal(dir.status, 400);
    assert.equal((dir.body as ApiErrorResponse).error, "not_a_file");

    const missing = await ask(harness, "?path=nope/none.txt");
    assert.equal(missing.status, 404);
    assert.equal((missing.body as ApiErrorResponse).error, "not_found");

    const empty = await ask(harness, "", EMPTY_RUN_ID);
    assert.equal(empty.status, 404);
    assert.equal((empty.body as ApiErrorResponse).error, "no_workspace");
    assert.match((empty.body as ApiErrorResponse).message, /no workspace/);

    const unknown = await ask(harness, "", "run-does-not-exist");
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body as ApiErrorResponse).error, "unknown_run");
  } finally {
    await harness.close();
  }
});
