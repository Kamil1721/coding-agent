import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canWriteDir,
  designPreflight,
  detectDesignCapability,
  execCommandRunner,
  geminiKeyAvailable,
  type CommandRunner,
} from "./design-capability.js";

function homeWithKeyFile(): string {
  const home = mkdtempSync(join(tmpdir(), "design-home-"));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "api_key"), "  sk-not-a-real-key\n", "utf8");
  return home;
}

const ok: CommandRunner = async () => ({ code: 0, stderr: "" });
const fails: CommandRunner = async () => ({ code: 127, stderr: "command not found" });

test("key resolution order is gemini-image.sh:36-39, VERBATIM", () => {
  const home = homeWithKeyFile();
  assert.equal(
    geminiKeyAvailable({ GEMINI_API_KEY: "a", NANOBANANA_API_KEY: "b" }, home).source,
    "GEMINI_API_KEY",
  );
  assert.equal(geminiKeyAvailable({ NANOBANANA_API_KEY: "b" }, home).source, "NANOBANANA_API_KEY");
  assert.equal(geminiKeyAvailable({}, home).source, "~/.gemini/api_key");
});

test("NO key anywhere resolves to unavailable — this is the degrade trigger, not an error", () => {
  const bare = mkdtempSync(join(tmpdir(), "design-home-empty-"));
  const resolution = geminiKeyAvailable({}, bare);
  assert.equal(resolution.available, false);
  assert.equal(resolution.source, null);
});

test("an EMPTY key file does not count as a key", () => {
  // `tr -d '[:space:]'` on a whitespace-only file yields "", and the script's
  // `[ -n "$KEY" ]` then dies at :40. A server-side check that said "available"
  // here would send the lane at a script guaranteed to fail.
  const home = mkdtempSync(join(tmpdir(), "design-home-blank-"));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "api_key"), "   \n\n", "utf8");
  assert.equal(geminiKeyAvailable({}, home).available, false);
});

test("the resolution NEVER carries the key value — only which source won", () => {
  // CLAUDE.md:18 and spec §7.5: never echo the key into a prompt, log or node.
  // The tightest way to keep that true is for the value never to leave this file.
  const home = homeWithKeyFile();
  const json = JSON.stringify(geminiKeyAvailable({ GEMINI_API_KEY: "sk-live-SECRET" }, home));
  assert.doesNotMatch(json, /sk-live-SECRET/);
  assert.doesNotMatch(json, /sk-not-a-real-key/);
});

test("video capability is FALSE while gemini-video.sh does not exist (§7.1a)", () => {
  const home = homeWithKeyFile();
  const capability = detectDesignCapability({
    env: {},
    homeDir: home,
    imageScript: join(home, "gemini-image.sh"),
    videoScript: join(home, "gemini-video.sh"),
  });
  assert.equal(capability.video, false, "2c has not landed; nothing may demand video");
});

test("video capability requires BOTH the script and a key", () => {
  const home = homeWithKeyFile();
  const videoScript = join(home, "gemini-video.sh");
  writeFileSync(videoScript, "#!/usr/bin/env bash\n", "utf8");
  const imageScript = join(home, "gemini-image.sh");
  writeFileSync(imageScript, "#!/usr/bin/env bash\n", "utf8");
  assert.equal(detectDesignCapability({ env: {}, homeDir: home, imageScript, videoScript }).video, true);

  const noKeyHome = mkdtempSync(join(tmpdir(), "design-home-nokey-"));
  assert.equal(
    detectDesignCapability({ env: {}, homeDir: noKeyHome, imageScript, videoScript }).video,
    false,
    "a script with no key generates nothing",
  );
});

test("preflight BLOCKS on a missing python3 — gemini-image.sh uses it twice (:48, :97)", async () => {
  const home = homeWithKeyFile();
  const script = join(home, "gemini-image.sh");
  writeFileSync(script, "#!/usr/bin/env bash\n", "utf8");
  const result = await designPreflight({
    env: {},
    homeDir: home,
    workspace: home,
    capability: detectDesignCapability({ env: {}, homeDir: home, imageScript: script }),
    run: async (command) => (command === "python3" ? { code: 127, stderr: "not found" } : { code: 0, stderr: "" }),
    canWrite: () => true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ["python3"]);
  assert.match(String(result.checks.find((c) => c.id === "python3")?.detail), /python3/);
});

test("preflight RECORDS but does not block on npx impeccable", async () => {
  const home = homeWithKeyFile();
  const script = join(home, "gemini-image.sh");
  writeFileSync(script, "#!/usr/bin/env bash\n", "utf8");
  const result = await designPreflight({
    env: {},
    homeDir: home,
    workspace: home,
    capability: detectDesignCapability({ env: {}, homeDir: home, imageScript: script }),
    run: async (command, args) =>
      command === "npx" && args.includes("impeccable") ? { code: 1, stderr: "not found" } : { code: 0, stderr: "" },
    canWrite: () => true,
  });
  assert.equal(result.ok, true, "one skill degrades; the lane does not");
  const check = result.checks.find((c) => c.id === "npx-impeccable");
  assert.equal(check?.ok, false);
  assert.equal(check?.blocking, false);
  assert.match(String(check?.detail), /impeccable/);
});

test("preflight blocks when NO key resolves, and names the degrade path", async () => {
  const bare = mkdtempSync(join(tmpdir(), "design-home-none-"));
  const script = join(bare, "gemini-image.sh");
  writeFileSync(script, "#!/usr/bin/env bash\n", "utf8");
  const result = await designPreflight({
    env: {},
    homeDir: bare,
    workspace: bare,
    capability: detectDesignCapability({ env: {}, homeDir: bare, imageScript: script }),
    run: ok,
    canWrite: () => true,
  });
  assert.deepEqual(result.blockers, ["gemini-key"]);
});

test("every check reports a DETAIL — a bare false is not actionable at 3am", async () => {
  const bare = mkdtempSync(join(tmpdir(), "design-home-detail-"));
  const result = await designPreflight({
    env: {},
    homeDir: bare,
    workspace: bare,
    capability: detectDesignCapability({ env: {}, homeDir: bare, imageScript: join(bare, "absent.sh") }),
    run: fails,
    canWrite: () => false,
  });
  for (const check of result.checks) assert.ok(check.detail.length > 0, `${check.id} has no detail`);
  assert.ok(result.checks.length === 5, "all five preflight rows are checked");
  // WHICH rows block is the central judgement call of this task, so it is pinned
  // rather than left to the prose. Every one of the five checks has failed here,
  // so this line says at once: python3/image-script/gemini-key stop the lane, and
  // npx-impeccable/tmpdir are recorded and do not. Without it, a later commit
  // could flip `tmpdir` to blocking and nothing would go red.
  assert.deepEqual(result.blockers, ["python3", "image-script", "gemini-key"]);
});

// THE INJECTED FAKES ABOVE PROVE THE POLICY. These two prove the REAL probes the
// orchestrator passes in, which every test above substitutes away. `spawn` of a
// missing binary emits an `error` event and never a `close` — so the `error`
// handler is the ONLY path by which "python3 is missing" becomes a blocker, and
// nothing else in this file executes it.
test("EXECUTED: the real runner reports an unspawnable binary as nonzero, not a throw", async () => {
  const result = await execCommandRunner("definitely-not-a-real-binary-2b", ["--version"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not be spawned/);
});

test("EXECUTED: the real runner reports a real success as code 0", async () => {
  // The negative control's control: without this arm, an execCommandRunner that
  // returned 127 for everything would satisfy the test above.
  const result = await execCommandRunner("true", []);
  assert.equal(result.code, 0);
});

test("EXECUTED: canWriteDir answers both ways against a real filesystem", () => {
  const writable = join(mkdtempSync(join(tmpdir(), "design-write-")), "nested", "deeper");
  assert.equal(canWriteDir(writable), true, "a directory it can create is writable");

  const sealed = mkdtempSync(join(tmpdir(), "design-sealed-"));
  chmodSync(sealed, 0o500);
  try {
    assert.equal(canWriteDir(join(sealed, "child")), false, "a directory it cannot create is not writable");
  } finally {
    chmodSync(sealed, 0o700);
  }
});

test("sandbox.network is still unconfigured — if that changes, the API host needs an allowlist", async () => {
  const { buildOptions } = await import("./builders/claude-builder.js");
  const options = buildOptions(
    {
      runId: "r1",
      prompt: "p",
      workspace: process.cwd(),
      sealedRoots: [],
      allowedAgents: [],
      modelId: "claude-opus-5",
      effort: null,
      resumeSessionId: null,
      signal: new AbortController().signal,
      sink: {} as never,
      env: {},
    },
    false,
  );
  const sandbox = options.sandbox as unknown as Record<string, unknown>;
  assert.equal(
    "network" in sandbox,
    false,
    "sandbox.network is now configured: gemini-image.sh:71 curls generativelanguage.googleapis.com, " +
      "so that host must be allowlisted or every generation fails with no PNG (spec §7.5).",
  );
});
