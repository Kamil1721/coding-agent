/**
 * design-env.test.ts — the two environment decisions a DESIGN run needs, one of
 * them MEASURED rather than asserted, and the measurement came back NEGATIVE.
 *
 * THE PLAN ASKED FOR "EXECUTED: mktemp -d actually honours TMPDIR". IT DOES NOT,
 * ON THIS PLATFORM, AND THAT IS THE FINDING. macOS `mktemp(1)` documents that
 * "if no arguments are passed or if only the -d flag is passed mktemp behaves as
 * if -t tmp was supplied", and that `-t` generates its template from
 * `_CS_DARWIN_USER_TEMP_DIR`, with TMPDIR only a FALLBACK "if
 * _CS_DARWIN_USER_TEMP_DIR is not available". On a Mac it is always available,
 * so TMPDIR is never consulted: measured 2026-07-29, `TMPDIR=<ws>/.design-tmp
 * mktemp -d` returned `/var/folders/…/T/tmp.TKv7kI91xj`.
 *
 * SO THE §7.5 MITIGATION IS INSUFFICIENT HERE, AND THE TESTS SAY SO RATHER THAN
 * ASSERTING THE PLAN'S FALSE UNIVERSAL. What replaces it is three executed arms:
 * the form that DOES land inside the workspace (an explicit template), the
 * measured platform truth for the bare form, and a seatbelt arm that reproduces
 * the production failure — `gemini-image.sh:43`'s bare `mktemp -d` denied under a
 * workspace-only `allow file-write*`, with the template form allowed beside it.
 *
 * Instance 10 in this project's defect log is an external tool silently
 * accepting an option it emulated nothing for. This is the same shape of claim,
 * which is why it is executed — and executing it is what caught it.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOptions, MOTION_BAR_ENV } from "./builders/claude-builder.js";
import type { BuildRequest } from "./builders/types.js";
import { STRIPPED_ENV_NAMES, subscriptionSubprocessEnv } from "./subprocess-env.js";
import { designSubprocessEnv, designTmpDirFor, DESIGN_TMP_DIR } from "./design-env.js";

const WS = "/runs/r1/workspace";

/**
 * The shape `buildOptions` is really handed, copied from
 * `builders/antislop-hook.test.ts:42-68` so the wiring arm below goes through
 * the SAME object `query()` receives rather than through a literal this file
 * invented.
 */
function req(overrides: Partial<BuildRequest> = {}): BuildRequest {
  const base: BuildRequest = {
    runId: "r1",
    prompt: "build it",
    workspace: WS,
    sealedRoots: [],
    allowedAgents: [],
    modelId: "claude-opus-5",
    effort: null,
    resumeSessionId: null,
    signal: new AbortController().signal,
    sink: {
      log() {},
      tool() {},
      tokens() {},
      rateLimit() {},
      session() {},
      environment() {},
      graph() {},
      contextUsage() {},
      compaction() {},
      raw() {},
    },
    env: {},
  };
  return { ...base, ...overrides };
}

test("TMPDIR is inside the workspace — the only path allowWrite permits", () => {
  const env = designSubprocessEnv({ TMPDIR: "/var/folders/xx" }, { workspace: WS, motionBar: false });
  assert.equal(env["TMPDIR"], join(WS, DESIGN_TMP_DIR));
  assert.ok(String(env["TMPDIR"]).startsWith(`${WS}/`));
});

test("TMPDIR overrides whatever the server inherited — an inherited one is the breakage", () => {
  const env = designSubprocessEnv({ TMPDIR: "/tmp" }, { workspace: WS, motionBar: false });
  assert.notEqual(env["TMPDIR"], "/tmp");
});

test("the motion bar is flipped ON only for a visual run, and the flag is the one the builder reads", () => {
  assert.equal(designSubprocessEnv({}, { workspace: WS, motionBar: true })[MOTION_BAR_ENV], "1");
  assert.equal(designSubprocessEnv({}, { workspace: WS, motionBar: false })[MOTION_BAR_ENV], undefined);
});

test("an inherited DASHBOARD_MOTION_BAR is not allowed to arm a non-visual run", () => {
  // The operator's shell must not turn the completion gate on for a CLI ticket:
  // measured in Phase 2a, `decideMotion` returns `unsatisfied` for this repo's own
  // client, so an accidental arm blocks a legitimate build.
  const env = designSubprocessEnv({ [MOTION_BAR_ENV]: "1" }, { workspace: WS, motionBar: false });
  assert.equal(env[MOTION_BAR_ENV], undefined);
});

test("the two Gemini key names are NOT stripped — and this test is the guard on that", () => {
  // Spec §7.5: they are deliberately absent from STRIPPED_ENV_NAMES
  // (subprocess-env.ts:39-55, "a subtraction, never an allowlist") so the DESIGN
  // lane can spend. If a later commit adds them "for safety", the lane silently
  // stops producing images and every failure looks like a script error.
  assert.equal(STRIPPED_ENV_NAMES.includes("GEMINI_API_KEY"), false);
  assert.equal(STRIPPED_ENV_NAMES.includes("NANOBANANA_API_KEY"), false);
  const kept = subscriptionSubprocessEnv({ GEMINI_API_KEY: "x", NANOBANANA_API_KEY: "y" });
  assert.equal(kept["GEMINI_API_KEY"], "x");
  assert.equal(kept["NANOBANANA_API_KEY"], "y");
});

test("ANTHROPIC_API_KEY is still stripped — widening for Gemini must not widen for the meter", () => {
  const env = designSubprocessEnv(
    { ANTHROPIC_API_KEY: "sk-ant", GEMINI_API_KEY: "g" },
    { workspace: WS, motionBar: false },
  );
  assert.equal(env["ANTHROPIC_API_KEY"], undefined, "costUsd: null must stay true");
  assert.equal(env["GEMINI_API_KEY"], "g");
});

/** A workspace whose path is REAL — seatbelt matches subpaths after symlinks. */
function realWorkspace(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function sh(script: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("/bin/sh", ["-c", script], { env, encoding: "utf8" });
  return { status: run.status, stdout: (run.stdout ?? "").trim(), stderr: (run.stderr ?? "").trim() };
}

// THE MEASUREMENT, NOT THE ASSUMPTION — and the measurement is why this arm is
// the EXPLICIT-TEMPLATE one rather than the plan's bare `mktemp -d`. See the file
// header: on darwin the bare form ignores TMPDIR outright.
test("EXECUTED: with TMPDIR set by this file, mktemp lands INSIDE the workspace", () => {
  const workspace = realWorkspace("design-ws-");
  const env = designSubprocessEnv(process.env, { workspace, motionBar: false });
  const tmp = String(env["TMPDIR"]);
  // THE TWO HALVES MUST NAME ONE DIRECTORY. `designTmpDirFor` is what the
  // orchestrator is told to `mkdirSync`; `env["TMPDIR"]` is what the subprocess
  // reads. If they ever drift, the run creates one directory and points the
  // script at another, and `mktemp` fails with ENOENT instead of a denial —
  // which is the same observable, and just as silent.
  assert.equal(tmp, designTmpDirFor(workspace));
  mkdirSync(tmp, { recursive: true });
  const made = sh('mktemp -d "$TMPDIR/tmp.XXXXXXXX"', env);
  assert.equal(made.status, 0, `mktemp failed: ${made.stderr}`);
  assert.ok(
    made.stdout.startsWith(`${tmp}/`),
    `mktemp wrote to ${made.stdout}, outside the workspace TMPDIR this file sets (${tmp}) — the §7.5 ` +
      `mitigation does not work on this platform and gemini-image.sh:43 will write outside allowWrite`,
  );
  rmSync(workspace, { recursive: true, force: true });
});

test("EXECUTED, THE PLATFORM TRUTH: a BARE `mktemp -d` does not honour TMPDIR on darwin", () => {
  // THE ARM THE PLAN GOT WRONG, kept as a measurement rather than deleted.
  // `gemini-image.sh:43` is exactly `TMPDIR_LOCAL="$(mktemp -d)"` — the bare form
  // — so this is the call the whole image chain actually makes. On darwin it
  // resolves through `_CS_DARWIN_USER_TEMP_DIR` and TMPDIR is never read; on GNU
  // coreutils the default template IS `$TMPDIR/tmp.XXXXXXXXXX`. Both directions
  // are asserted, so this file records WHICH platform it measured rather than
  // passing everywhere by saying nothing.
  const workspace = realWorkspace("design-ws-bare-");
  const env = designSubprocessEnv(process.env, { workspace, motionBar: false });
  const tmp = String(env["TMPDIR"]);
  mkdirSync(tmp, { recursive: true });
  const made = sh("mktemp -d", env);
  assert.equal(made.status, 0, `mktemp failed: ${made.stderr}`);
  const inside = made.stdout.startsWith(`${tmp}/`);
  if (process.platform === "darwin") {
    assert.equal(
      inside,
      false,
      `mktemp -d landed in ${made.stdout}, inside TMPDIR — darwin's mktemp has started honouring the ` +
        `variable, so the §7.5 mitigation may now be sufficient and this file's conclusion is stale`,
    );
  } else {
    assert.equal(
      inside,
      true,
      `mktemp -d landed in ${made.stdout}, outside the TMPDIR this file sets — setting TMPDIR buys ` +
        `nothing here either, and gemini-image.sh:43 needs an explicit template on this platform too`,
    );
  }
  rmSync(made.stdout, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("EXECUTED, SEATBELT: a workspace-only allowWrite DENIES the bare mktemp -d and ALLOWS the template", (t) => {
  // §7.5'S RISK ROW, REPRODUCED RATHER THAN DESCRIBED. The profile below is the
  // shape the CLI generates from `sandbox.filesystem.allowWrite` — read out of
  // the shipped binary: `(deny default)` plus one `(allow file-write* (subpath
  // X))` per allowed path. Three arms, because one alone proves nothing:
  //
  //   bare mktemp -d      DENIED  — this is gemini-image.sh:43, and it is the
  //                                 silent breakage: no PNG, an error only on a
  //                                 stream `decideToolPermission` never sees.
  //   explicit template   ALLOWED — the same call with `$TMPDIR/tmp.XXXXXXXX`
  //                                 works, so the denial above is about WHERE
  //                                 mktemp chose to write, not about mktemp.
  //   write outside ws    DENIED  — the control on the profile itself. Without
  //                                 it, a profile that failed to load would give
  //                                 the same green as one that enforces.
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    t.skip("seatbelt is macOS-only — this arm records the platform whose sandbox it measured");
    return;
  }
  const workspace = realWorkspace("design-sbx-");
  const env = designSubprocessEnv(process.env, { workspace, motionBar: false });
  const tmp = String(env["TMPDIR"]);
  mkdirSync(tmp, { recursive: true });
  const profile = join(workspace, "profile.sb");
  writeFileSync(
    profile,
    [
      "(version 1)",
      '(deny default (with message "design-env-test"))',
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow process-info* (target same-sandbox))",
      "(allow signal (target same-sandbox))",
      "(allow sysctl-read)",
      "(allow file-read*)",
      "(allow user-preference-read)",
      '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
      // THE CLI'S OWN DEFAULTS, NOT JUST OURS. Read out of the shipped binary
      // (claude-code 2.1.220): the write allowlist is `[...defaults, ...allowWrite]`
      // and the defaults include `/tmp/claude` and `/private/tmp/claude`, because
      // the CLI also injects `TMPDIR=${CLAUDE_CODE_TMPDIR || CLAUDE_TMPDIR ||
      // "/tmp/claude"}` into every sandboxed command. Omitting them here would
      // make this profile STRICTER than production, and the denial below would be
      // an artefact of the test rather than evidence about the real sandbox.
      '(allow file-write* (subpath "/tmp/claude"))',
      '(allow file-write* (subpath "/private/tmp/claude"))',
      `(allow file-write* (subpath ${JSON.stringify(workspace)}))`,
      "",
    ].join("\n"),
    "utf8",
  );
  const sandboxed = (script: string) => {
    const run = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", script], {
      env,
      encoding: "utf8",
    });
    return { status: run.status, stdout: (run.stdout ?? "").trim(), stderr: (run.stderr ?? "").trim() };
  };

  const bare = sandboxed("mktemp -d");
  assert.notEqual(
    bare.status,
    0,
    `the bare mktemp -d SUCCEEDED under a workspace-only allowWrite, writing ${bare.stdout} — the §7.5 ` +
      `row is no longer true and gemini-image.sh:43 is not the breakage this file says it is`,
  );
  assert.match(
    bare.stderr,
    /not permitted/i,
    `expected a sandbox denial; got status ${String(bare.status)} and stderr ${bare.stderr}`,
  );

  // AND THE CLI'S OWN TMPDIR DOES NOT SAVE IT EITHER. `/tmp/claude` is write-
  // allowed above, so a tool that read TMPDIR would succeed here. The bare form
  // fails anyway, and the path in the error is the proof it never read it.
  const cliTmp = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", "mktemp -d"], {
    env: { ...env, TMPDIR: "/tmp/claude" },
    encoding: "utf8",
  });
  assert.notEqual(
    cliTmp.status,
    0,
    `with the CLI's own TMPDIR=/tmp/claude — a path the sandbox permits — the bare mktemp -d SUCCEEDED, ` +
      `writing ${(cliTmp.stdout ?? "").trim()}. Then darwin's mktemp does read TMPDIR after all.`,
  );

  const templated = sandboxed('mktemp -d "$TMPDIR/tmp.XXXXXXXX"');
  assert.equal(
    templated.status,
    0,
    `the TEMPLATE form was denied too (${templated.stderr}) — then no TMPDIR fixes this and the ` +
      `mitigation is not "set TMPDIR", it is "widen allowWrite"`,
  );
  assert.ok(templated.stdout.startsWith(`${tmp}/`), `template form wrote to ${templated.stdout}`);

  const outside = sandboxed(`touch ${JSON.stringify(join(tmpdir(), "design-env-control"))}`);
  assert.notEqual(
    outside.status,
    0,
    "a write outside the workspace was PERMITTED — the profile did not load, so the denial above is " +
      "not evidence of anything",
  );
  rmSync(workspace, { recursive: true, force: true });
});

test("WIRING: the env this file builds is what arms buildOptions' Layer-2 Stop hooks — both directions", () => {
  // NOT A DUPLICATE of `antislop-hook.test.ts`'s "the motion bar is OFF by default
  // and ARMED by the env flag": that test hand-writes `{ [MOTION_BAR_ENV]: "1" }`
  // and proves buildOptions READS the flag. This one proves what THIS FUNCTION
  // EMITS satisfies buildOptions' real predicate, `(request.env[MOTION_BAR_ENV] ??
  // "").trim() === "1"` (claude-builder.ts:751-754). A flip that wrote "true", or
  // "1\n", or a differently-spelled name would leave that test green and the gate
  // permanently unreachable — the shape this project's defect log records as "the
  // assertion and the production path were never connected".
  const armed = buildOptions(req({ env: designSubprocessEnv({}, { workspace: WS, motionBar: true }) }), false);
  assert.equal(armed.hooks?.Stop?.length, 1, "the flip did not arm the Stop slot — the gate is unreachable");
  assert.equal(armed.hooks?.SubagentStop?.length, 1, "subagents would be ungated");

  // The disarmed arm starts from an env that ALREADY carries the flag, so it is
  // the `delete` — not the absence of a write — that has to reach buildOptions.
  const disarmed = buildOptions(
    req({ env: designSubprocessEnv({ [MOTION_BAR_ENV]: "1" }, { workspace: WS, motionBar: false }) }),
    false,
  );
  assert.equal(disarmed.hooks?.Stop, undefined, "an operator's shell armed a completion gate on a CLI ticket");
  assert.equal(disarmed.hooks?.SubagentStop, undefined);
});
