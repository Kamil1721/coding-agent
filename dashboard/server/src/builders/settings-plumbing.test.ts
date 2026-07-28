/**
 * settings-plumbing.test.ts — does `sandbox.filesystem.denyRead` actually reach
 * the CLI?
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. The Claude driver denies reads of the
 * sealed suite in two layers. Layer 1 (`decideToolPermission`) is unit-tested
 * next door. Layer 2 is `sandbox.filesystem.denyRead`, enforced by the CLI's own
 * OS sandbox — and it is the ONLY layer that covers Bash, because
 * `autoAllowBashIfSandboxed: true` means a sandboxed command never reaches
 * `canUseTool`.
 *
 * Proving that the OS sandbox ENFORCES the denial would need a real build,
 * which costs subscription quota. What can be proved for free is the half that
 * silently breaks: that the value leaves this program and arrives at the CLI.
 * The SDK is run against a STUB EXECUTABLE — `pathToClaudeCodeExecutable`
 * pointed at a script that records its argv and exits — so no model is called,
 * no credential is used and no quota is consumed. The `--settings` payload is
 * then parsed and asserted.
 *
 * If this test fails, the deny is not reaching the CLI and only layer 1 is
 * standing. If it passes, the configuration is correct and enforcement remains
 * UNEXERCISED. Both statements are in dashboard/STATUS.md, separately.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";

/** A stand-in for the CLI binary: record argv, then exit. Never talks to anything. */
const STUB = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.ARGV_SINK, JSON.stringify(process.argv.slice(2)), "utf8");
process.exit(0);
`;

function settingsFromArgv(argv: readonly string[]): Record<string, unknown> {
  let raw: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--settings") raw = argv[i + 1] ?? null;
    else if (arg.startsWith("--settings=")) raw = arg.slice("--settings=".length);
  }
  assert.ok(raw !== null, `no --settings flag in the CLI invocation: ${JSON.stringify(argv)}`);
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === "object" && parsed !== null, "--settings was not a JSON object");
  return parsed as Record<string, unknown>;
}

test("sandbox.filesystem.denyRead carries the sealed suite root into the CLI's --settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-plumbing-"));
  const stubPath = join(dir, "stub-cli.mjs");
  const sink = join(dir, "argv.json");
  writeFileSync(stubPath, STUB, "utf8");

  const heldOutRoot = join(dir, "acceptance");
  const workspace = join(dir, "workspace");

  const abortController = new AbortController();
  const session = query({
    prompt: "never dispatched: the stub exits before reading stdin",
    options: {
      abortController,
      cwd: dir,
      pathToClaudeCodeExecutable: stubPath,
      settingSources: [],
      // The exact shape claude-builder.ts uses.
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [workspace], denyRead: [heldOutRoot] },
      },
      env: { ...process.env, ARGV_SINK: sink } as Record<string, string>,
    },
  });

  // The stub exits immediately, so the SDK's transport fails. That failure is
  // the expected outcome: what is under test is the argv it was spawned with.
  try {
    for await (const _ of session as AsyncIterable<unknown>) {
      void _;
      break;
    }
  } catch {
    // expected
  } finally {
    try {
      session.close();
    } catch {
      // already dead
    }
    abortController.abort();
  }

  assert.ok(existsSync(sink), "the stub CLI was never spawned, so nothing was proved");
  const argv = JSON.parse(readFileSync(sink, "utf8")) as string[];

  const settings = settingsFromArgv(argv);
  const sandbox = settings["sandbox"] as Record<string, unknown> | undefined;
  assert.ok(sandbox !== undefined, `--settings carried no sandbox key: ${JSON.stringify(settings)}`);
  const filesystem = sandbox["filesystem"] as Record<string, unknown> | undefined;
  assert.ok(filesystem !== undefined, "the sandbox settings carried no filesystem key");

  assert.deepEqual(filesystem["denyRead"], [heldOutRoot], "denyRead did not reach the CLI intact");
  assert.deepEqual(filesystem["allowWrite"], [workspace], "allowWrite did not reach the CLI intact");
});
