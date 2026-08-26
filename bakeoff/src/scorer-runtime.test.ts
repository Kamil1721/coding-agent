import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BakeoffError } from "./contracts.js";
import {
  DEFAULT_SCORER_CONTAINER,
  SCORER_RUNTIME_PROBE_TIMEOUT_MS,
  assertSealedInvocation,
  buildScorerRuntimeProbeArgs,
  probeScorerRuntime,
} from "./scorer.js";
import type { ScorerContainerSpec, ScorerProcessOutcome, ScorerProcessRunner } from "./scorer.js";
import {
  SCORER_RUNTIME_SMOKE_ARG,
  formatScorerRuntimeSmoke,
  runScorerRuntimeSmoke,
} from "./scorer-runtime.js";
import type { ScorerRuntimeSmokePayload } from "./scorer-runtime.js";
import { SCORER_PROTOCOL_VERSION } from "./scorer-protocol.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const SPEC: ScorerContainerSpec = {
  ...DEFAULT_SCORER_CONTAINER,
  imageRef: "registry.example/bakeoff-scorer:mutable",
  platform: "linux/arm64",
  user: "1234:5678",
  memory: "5g",
  cpus: "1.5",
  shmSize: "768m",
  pidsLimit: 777,
  tmpfsSize: "3g",
  dockerBin: "docker-test",
};

const SMOKE: ScorerRuntimeSmokePayload = {
  smokeVersion: 2,
  status: "ok",
  protocolVersion: SCORER_PROTOCOL_VERSION,
  nodeVersion: "v24.7.0",
  playwrightVersion: "1.62.0",
  chromiumVersion: "Chromium 140.0.0.0",
  checkedFiles: ["package.json", "/ms-playwright"],
};

function outcome(overrides: Partial<ScorerProcessOutcome> = {}): ScorerProcessOutcome {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    signal: null,
    launchError: null,
    ...overrides,
  };
}

const INSPECT = outcome({
  stdout: `${IMAGE_ID}\t["registry.example/bakeoff-scorer@${IMAGE_ID}"]\t["registry.example/bakeoff-scorer:mutable"]\n`,
});

function smokeFixture(): { readonly root: string; readonly browsers: string } {
  const root = mkdtempSync(join(tmpdir(), "bakeoff-smoke-"));
  const browsers = join(root, "browsers");
  for (const relativePath of ["dist", "node_modules/@playwright/test", "browsers"]) {
    mkdirSync(join(root, relativePath), { recursive: true });
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@playwright/test": "1.62.0" } }));
  writeFileSync(join(root, "node_modules/@playwright/test/package.json"), JSON.stringify({ version: "1.62.0" }));
  for (const relativePath of ["dist/scorer-container.js", "playwright.config.mjs", "node-test-reporter.mjs"]) {
    writeFileSync(join(root, relativePath), "export default {};\n", "utf8");
  }
  return { root, browsers };
}

function validRuntimeModule(path: string): unknown {
  return path.endsWith("node-test-reporter.mjs") ? { default: async function* reporter() {} } : { default: {} };
}

test("container smoke loads both runner modules and launches then closes Chromium", async () => {
  const fixture = smokeFixture();
  const loaded: string[] = [];
  let launched = false;
  let closed = false;
  let launchOptions: unknown = null;
  try {
    const smoke = await runScorerRuntimeSmoke(
      { BAKEOFF_SCORER_SEALED: "1", PLAYWRIGHT_BROWSERS_PATH: fixture.browsers },
      {
        scorerHome: fixture.root,
        loadRuntimeModule: async (path) => { loaded.push(path); return validRuntimeModule(path); },
        loadPlaywright: async () => ({
          chromium: {
            launch: async (options) => {
              launched = true;
              launchOptions = options;
              return {
                version: () => "Chromium 140.0.0.0",
                close: async () => { closed = true; },
              };
            },
          },
        }),
      },
    );
    assert.equal(smoke.smokeVersion, 2);
    assert.equal(smoke.chromiumVersion, "Chromium 140.0.0.0");
    assert.deepEqual(loaded, [
      join(fixture.root, "playwright.config.mjs"),
      join(fixture.root, "node-test-reporter.mjs"),
    ]);
    assert.equal(launched, true);
    assert.equal(closed, true);
    assert.deepEqual(launchOptions, {
      headless: true,
      chromiumSandbox: false,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("container smoke fails closed when a runner module or Chromium cannot load", async () => {
  const fixture = smokeFixture();
  const env = { BAKEOFF_SCORER_SEALED: "1", PLAYWRIGHT_BROWSERS_PATH: fixture.browsers };
  try {
    await assert.rejects(
      runScorerRuntimeSmoke(env, {
        scorerHome: fixture.root,
        loadRuntimeModule: async (path) => {
          if (path.endsWith("playwright.config.mjs")) throw new SyntaxError("invalid config");
          return validRuntimeModule(path);
        },
      }),
      /invalid config/u,
    );
    await assert.rejects(
      runScorerRuntimeSmoke(env, {
        scorerHome: fixture.root,
        loadRuntimeModule: async (path) => validRuntimeModule(path),
        loadPlaywright: async () => { throw new Error("Playwright module missing"); },
      }),
      /Playwright module missing/u,
    );
    await assert.rejects(
      runScorerRuntimeSmoke(env, {
        scorerHome: fixture.root,
        loadRuntimeModule: async (path) => validRuntimeModule(path),
        loadPlaywright: async () => ({
          chromium: { launch: async () => { throw new Error("Chromium executable missing"); } },
        }),
      }),
      /Chromium executable missing/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("container smoke closes Chromium when the launched browser reports an invalid version", async () => {
  const fixture = smokeFixture();
  let closes = 0;
  try {
    await assert.rejects(
      runScorerRuntimeSmoke(
        { BAKEOFF_SCORER_SEALED: "1", PLAYWRIGHT_BROWSERS_PATH: fixture.browsers },
        {
          scorerHome: fixture.root,
          loadRuntimeModule: async (path) => validRuntimeModule(path),
          loadPlaywright: async () => ({
            chromium: {
              launch: async () => ({
                version: () => "",
                close: async () => { closes += 1; },
              }),
            },
          }),
        },
      ),
      /reported no version/u,
    );
    assert.equal(closes, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

interface RecordedCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly maxOutputChars: number | undefined;
  readonly signal: AbortSignal | undefined;
}

function sequenceRunner(
  responses: readonly ScorerProcessOutcome[],
  calls: RecordedCall[],
): ScorerProcessRunner {
  let index = 0;
  return async (bin, args, timeoutMs, env, _onTimeout, maxOutputChars, signal) => {
    calls.push({ bin, args, timeoutMs, env, maxOutputChars, signal });
    const response = responses[index];
    index += 1;
    assert.ok(response, `unexpected process call ${index}: ${bin} ${args.join(" ")}`);
    return response;
  };
}

test("runtime probe args execute the exact digest under the critical scoring seal", () => {
  const args = buildScorerRuntimeProbeArgs(SPEC, IMAGE_ID, "smoke-fixed");
  assert.doesNotThrow(() => assertSealedInvocation(args, IMAGE_ID, [SCORER_RUNTIME_SMOKE_ARG]));
  assert.deepEqual(args.slice(-2), [IMAGE_ID, SCORER_RUNTIME_SMOKE_ARG]);
  assert.equal(args.some((arg) => arg.startsWith("--mount=")), false, "smoke must mount no score inputs");
  for (const flag of [
    "--rm",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "no-new-privileges",
    "--pids-limit=777",
    "--memory=5g",
    "--cpus=1.5",
    "--shm-size=768m",
    "--tmpfs=/tmp:rw,nosuid,nodev,exec,size=3g",
    "--platform=linux/arm64",
    "--user=1234:5678",
    "--env=BAKEOFF_SCORER_SEALED=1",
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
});

test("runtime probe args reject non-digests and seal negative controls", () => {
  assert.throws(
    () => buildScorerRuntimeProbeArgs(SPEC, SPEC.imageRef, "smoke-fixed"),
    (error: unknown) => error instanceof BakeoffError && /not a sha256 digest/u.test(error.message),
  );

  const good = buildScorerRuntimeProbeArgs(SPEC, IMAGE_ID, "smoke-fixed");
  for (const missing of ["--network=none", "--read-only", "--cap-drop=ALL", "--env=BAKEOFF_SCORER_SEALED=1"]) {
    const mutated = good.filter((arg) => arg !== missing);
    assert.throws(
      () => assertSealedInvocation(mutated, IMAGE_ID, [SCORER_RUNTIME_SMOKE_ARG]),
      (error: unknown) => error instanceof BakeoffError && error.message.includes(missing),
      `removing ${missing} must break the seal`,
    );
  }

  const imageIndex = good.indexOf(IMAGE_ID);
  const reordered = good.filter((arg) => arg !== IMAGE_ID);
  reordered.splice(2, 0, IMAGE_ID);
  assert.throws(
    () => assertSealedInvocation(reordered, IMAGE_ID, [SCORER_RUNTIME_SMOKE_ARG]),
    (error: unknown) =>
      error instanceof BakeoffError &&
      /does not contain "--network=none"/u.test(error.message),
    `moving the image from argument ${String(imageIndex)} ahead of Docker's seal flags must break the seal`,
  );

  const injectedImage = [...good];
  injectedImage.splice(2, 0, "attacker-image:latest");
  assert.throws(
    () => assertSealedInvocation(injectedImage, IMAGE_ID, [SCORER_RUNTIME_SMOKE_ARG]),
    (error: unknown) =>
      error instanceof BakeoffError &&
      /first positional Docker image operand is "attacker-image:latest"/u.test(error.message),
    "an earlier positional image must not be hidden by the expected digest later in the vector",
  );

  for (const separateValue of ["smoke-fixed", "no-new-privileges"]) {
    const missingSeparateValue = [...good];
    missingSeparateValue.splice(missingSeparateValue.indexOf(separateValue), 1);
    assert.throws(
      () => assertSealedInvocation(missingSeparateValue, IMAGE_ID, [SCORER_RUNTIME_SMOKE_ARG]),
      (error: unknown) =>
        error instanceof BakeoffError &&
        /contains no positional Docker image operand/u.test(error.message),
      `removing separate option value ${separateValue} must fail closed before the next seal flag is parsed`,
    );
  }
});

test("runtime readiness resolves once, executes that digest, and exposes provenance", async () => {
  const calls: RecordedCall[] = [];
  const runner = sequenceRunner([INSPECT, outcome({ stdout: `${formatScorerRuntimeSmoke(SMOKE)}\n` })], calls);
  const result = await probeScorerRuntime(
    SPEC,
    {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      DOCKER_HOST: "unix:///safe/docker.sock",
      OPENAI_API_KEY: "must-not-cross-the-process-boundary",
    },
    { runProcess: runner, containerName: () => "smoke-fixed" },
  );

  assert.equal(result.imageRef, SPEC.imageRef);
  assert.equal(result.imageDigest, IMAGE_ID);
  assert.deepEqual(result.image.repoTags, [SPEC.imageRef]);
  assert.deepEqual(result.smoke, SMOKE);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.args.slice(-2), [IMAGE_ID, SCORER_RUNTIME_SMOKE_ARG]);
  assert.equal(calls[1]?.timeoutMs, SCORER_RUNTIME_PROBE_TIMEOUT_MS);
  assert.equal(calls[1]?.maxOutputChars, 64 * 1024);
  assert.equal(calls[1]?.env["OPENAI_API_KEY"], undefined);
  assert.equal(calls[1]?.env["DOCKER_HOST"], "unix:///safe/docker.sock");
});

async function runtimeFailure(
  runtimeOutcome: ScorerProcessOutcome,
): Promise<BakeoffError> {
  const calls: RecordedCall[] = [];
  const runner = sequenceRunner([INSPECT, runtimeOutcome], calls);
  try {
    await probeScorerRuntime(SPEC, {}, { runProcess: runner, containerName: () => "smoke-fixed" });
  } catch (error) {
    assert.ok(error instanceof BakeoffError, `expected BakeoffError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected runtime probe failure");
}

test("runtime readiness reports timeout and launch failures distinctly", async () => {
  const timeout = await runtimeFailure(outcome({ exitCode: -1, timedOut: true, signal: "SIGKILL" }));
  assert.match(timeout.message, /exceeded its 30000 ms boundary/u);
  assert.match(timeout.remediation, /resource limits/u);

  const launch = await runtimeFailure(
    outcome({ exitCode: -1, launchError: "spawn docker-test ENOENT", stderr: "spawn docker-test ENOENT" }),
  );
  assert.match(launch.message, /could not launch/u);
  assert.match(launch.remediation, /Install or configure docker-test/u);
});

test("runtime readiness fails closed on old-image exits and malformed success output", async () => {
  const nonzero = await runtimeFailure(
    outcome({ exitCode: 1, stderr: "ENOENT: /scorer/input/plan.json" }),
  );
  assert.match(nonzero.message, /failed \(exit 1\)/u);
  assert.match(nonzero.remediation, /includes the --smoke entrypoint/u);

  const malformed = await runtimeFailure(outcome({ stdout: "all good\n" }));
  assert.match(malformed.message, /malformed output/u);
  assert.match(malformed.remediation, /zero exit without/u);
});

test("runtime readiness forwards cancellation and kills its named container exactly once", async () => {
  const controller = new AbortController();
  const reason = new Error("owner cancelled readiness");
  let runtimeSignal: AbortSignal | undefined;
  let announceRuntime: (() => void) | null = null;
  const runtimeStarted = new Promise<void>((resolve) => { announceRuntime = resolve; });
  let killCalls = 0;
  const runner: ScorerProcessRunner = async (_bin, args, _timeout, _env, _onTimeout, _max, signal) => {
    if (args[0] === "image") return INSPECT;
    if (args[0] === "kill") {
      killCalls += 1;
      assert.deepEqual(args, ["kill", "smoke-fixed"]);
      return outcome();
    }
    runtimeSignal = signal;
    announceRuntime?.();
    return await new Promise<ScorerProcessOutcome>((resolve) => {
      signal?.addEventListener(
        "abort",
        () => resolve(outcome({ exitCode: -1, signal: "SIGKILL", launchError: "AbortError" })),
        { once: true },
      );
    });
  };

  const pending = probeScorerRuntime(SPEC, {}, {
    runProcess: runner,
    containerName: () => "smoke-fixed",
    signal: controller.signal,
  });
  await runtimeStarted;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(runtimeSignal, controller.signal);
  assert.equal(killCalls, 1);
});
