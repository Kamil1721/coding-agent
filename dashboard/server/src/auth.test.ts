/**
 * auth.test.ts — the login probe, including the state that costs money.
 *
 * WHY THIS FILE EXISTS. The probe used to read one field, `loggedIn`, from the
 * raw process environment. Measured on this machine with an isolated empty
 * CLAUDE_CONFIG_DIR:
 *
 *   (no key)               -> {"loggedIn": false, "authMethod": "none"}
 *   ANTHROPIC_API_KEY=<x>  -> {"loggedIn": true,  "authMethod": "api_key"}
 *
 * So an unauthenticated machine reported "logged in" whenever the shell held an
 * API key — which bakeoff's own `.env.example` asks the owner to set. Health
 * said go, the picker enabled the subscription models, and the build then
 * failed on authentication, because every build strips that variable. Worse in
 * the other direction: the UI promises "Included in your plan" while the
 * identity behind it is billed per token.
 *
 * The stub CLI below lets the billed case be EXERCISED rather than reasoned
 * about — a settings-file key or an `apiKeyHelper` produces exactly this output
 * and cannot be stripped from an environment.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_LOGIN_COMMAND, CODEX_LOGIN_COMMAND, probeClaudeAuth, probeCodexAuth } from "./auth.js";
import { STRIPPED_ENV_NAMES } from "./subprocess-env.js";

/** A `claude` stand-in that prints a fixed status document and exits `code`. */
function stubClaude(body: string, code = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-stub-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\nexit ${String(code)}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A `codex` stand-in. `codex login status` has no --json; it prints prose. */
function stubCodex(text: string, code: number): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-stub-"));
  const path = join(dir, "codex");
  writeFileSync(path, `#!/bin/sh\necho '${text}'\nexit ${String(code)}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

test("a subscription login is ok", async () => {
  for (const method of ["claude.ai", "oauth_token"]) {
    const bin = stubClaude(`{"loggedIn": true, "authMethod": "${method}"}`);
    const result = await probeClaudeAuth({ claudeBin: bin, env: {} });
    assert.equal(result.state, "ok", `${method} is a subscription login`);
  }
});

test("AN API KEY IS NOT A SUBSCRIPTION: loggedIn:true + api_key reads as missing", async () => {
  const bin = stubClaude('{"loggedIn": true, "authMethod": "api_key", "apiKeySource": "user"}');
  const result = await probeClaudeAuth({ claudeBin: bin, env: {} });
  assert.equal(result.state, "missing", "a billed identity must never be reported as ok");
  assert.match(result.detail, /API KEY/, "the detail must name what is wrong");
  assert.match(result.detail, /BILLED/, "the detail must say why it is refused");
  assert.ok(result.detail.includes(CLAUDE_LOGIN_COMMAND), "the detail must carry the fix command");
});

test("an unrecognised authMethod reads as missing, naming the value", async () => {
  // Asymmetric on purpose: the failure direction here is silent spending.
  const bin = stubClaude('{"loggedIn": true, "authMethod": "some_future_mode"}');
  const result = await probeClaudeAuth({ claudeBin: bin, env: {} });
  assert.equal(result.state, "missing");
  assert.match(result.detail, /some_future_mode/, "an unseen value must be surfaced, not swallowed");
});

test("not logged in reads as missing even though the CLI exits non-zero with JSON", async () => {
  // Measured on CLI 2.1.220: exit 1 WITH a complete status document. Judging
  // the exit code first would discard authMethod.
  const bin = stubClaude('{"loggedIn": false, "authMethod": "none"}', 1);
  const result = await probeClaudeAuth({ claudeBin: bin, env: {} });
  assert.equal(result.state, "missing");
  assert.match(result.detail, /no authenticated session/);
  assert.ok(result.detail.includes(CLAUDE_LOGIN_COMMAND));
});

test("a CLI that is absent or prints prose reads as missing, with the fix command", async () => {
  const result = await probeClaudeAuth({ claudeBin: join(tmpdir(), "definitely-not-a-binary"), env: {} });
  assert.equal(result.state, "missing");
  assert.ok(result.detail.includes(CLAUDE_LOGIN_COMMAND));
});

test("THE PROBE SEES THE SAME ENVIRONMENT A BUILD SEES", async () => {
  // The stub echoes its own environment back as the status document's fields,
  // so the assertion is about what the child actually received.
  const dir = mkdtempSync(join(tmpdir(), "auth-stub-"));
  const path = join(dir, "claude");
  writeFileSync(
    path,
    '#!/bin/sh\nprintf \'{"loggedIn": true, "authMethod": "%s"}\\n\' "${ANTHROPIC_API_KEY:-claude.ai}"\n',
    "utf8",
  );
  chmodSync(path, 0o755);

  const polluted: NodeJS.ProcessEnv = {};
  for (const name of STRIPPED_ENV_NAMES) polluted[name] = "value-that-must-not-survive";

  const result = await probeClaudeAuth({ claudeBin: path, env: polluted });
  assert.equal(
    result.state,
    "ok",
    "the child saw ANTHROPIC_API_KEY, so the probe answered for a session the run will never open",
  );
});

test("codex: not logged in is missing and names `codex login`", async () => {
  const result = await probeCodexAuth({ codexBin: stubCodex("Not logged in", 1), env: {} });
  assert.equal(result.state, "missing");
  assert.ok(result.detail.includes(CODEX_LOGIN_COMMAND));
});

test("codex: exit 0 without the not-logged-in wording is ok", async () => {
  const result = await probeCodexAuth({ codexBin: stubCodex("Logged in using ChatGPT", 0), env: {} });
  assert.equal(result.state, "ok");
});

test("no probe detail ever carries an email, an org id or a token", async () => {
  const bin = stubClaude(
    '{"loggedIn": true, "authMethod": "claude.ai", "email": "someone@example.com",' +
      ' "orgId": "org-abc", "orgName": "Someone Org", "subscriptionType": "max"}',
  );
  const result = await probeClaudeAuth({ claudeBin: bin, env: {} });
  for (const leak of ["someone@example.com", "org-abc", "Someone Org"]) {
    assert.ok(!result.detail.includes(leak), `probe detail leaked ${leak}`);
  }
});
