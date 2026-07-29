// dashboard/server/gemini-video-harness.mjs
//
// Drives the REAL ~/.claude/scripts/gemini-video.sh against a loopback fake Veo
// endpoint. NOT part of `npm test`: it spawns bash and binds a port, and the
// script it exercises lives outside the repository. Run it explicitly:
//
//   node --test dashboard/server/gemini-video-harness.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startFakeVeo } from "./gemini-video-fake.mjs";

const SCRIPT = join(process.env.HOME, ".claude", "scripts", "gemini-video.sh");
const SENTINEL_KEY = "SENTINEL-KEY-DO-NOT-PRINT-9f3a";
const run = promisify(execFile);

/**
 * A 4x4 PNG, so `-i` has a real file to base64 AND to hand to cwebp.
 *
 * DEVIATION FROM THE PLAN, STATED: the plan's literal blob has an IDAT chunk
 * whose declared length disagrees with its content, so libpng emits
 * "IDAT: Too much image data" on every poster conversion. It happens to still
 * exit 0, but a fixture that is malformed on purpose-by-accident is a landmine
 * for anything later that asserts on converter stderr. This blob is generated
 * and CRC-verified: 4x4 RGB, every chunk's CRC checked against zlib.crc32.
 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR42mP4z8AARwzEcQCukw/xOF6MEQAAAABJRU5ErkJggg==";

export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "veo-"));
  const still = join(dir, "still.png");
  writeFileSync(still, Buffer.from(PNG_B64, "base64"));
  return { dir, still, out: join(dir, "leg-1.mp4"), poster: join(dir, "leg-1-poster.webp") };
}

/** Every invocation goes through here so no test can forget the override. */
export async function runScript(args, { base, env = {}, timeout = 15_000 } = {}) {
  try {
    const { stdout, stderr } = await run(SCRIPT, args, {
      timeout,
      killSignal: "SIGKILL",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GEMINI_API_KEY: SENTINEL_KEY,
        GEMINI_VIDEO_API_BASE: base,
        GEMINI_VIDEO_POLL_SEC: "0.2",
        GEMINI_VIDEO_TIMEOUT_SEC: "3",
        ...env,
      },
    });
    return { code: 0, stdout, stderr, killed: false };
  } catch (e) {
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", killed: e.killed === true };
  }
}

/**
 * A fake server whose close is registered with the TEST CONTEXT, not written
 * after the assertions.
 *
 * MEASURED, not stylistic: with `await fake.close()` as the last line of a test
 * body — which is how the plan writes it — the first failing assertion throws
 * past the close, the listening handle keeps the process alive, and `node
 * --test` never exits. Every RED step of this TDD plan would hang instead of
 * reporting. Observed on the very first run of this file: the ENOENT step had
 * to be SIGKILLed at 120s. The plan's trailing `await fake.close()` lines are
 * kept as written; this just makes them unnecessary on the failure path.
 */
async function fakeFor(t, options = {}) {
  const fake = await startFakeVeo(options);
  t.after(() => fake.close());
  return fake;
}

test("THE OVERRIDE TOOK EFFECT — the script reached the fake server, not Google", async (t) => {
  // Instance 10: an option an external tool silently ignores makes every test
  // under it pass while emulating nothing. FAKE-SENTINEL-7 is an operation name
  // Google cannot return, so seeing it is proof the request went where we said.
  const fake = await fakeFor(t, { pollsBeforeDone: 1 });
  const f = fixture();
  const r = await runScript(["a slow push-in over the hero", "-i", f.still, "-o", f.out], { base: fake.url });
  const posts = fake.requests.filter((q) => q.method === "POST");
  assert.equal(posts.length, 1, "exactly one predictLongRunning POST");
  assert.equal(
    posts[0].path,
    "/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
    "the endpoint is the spec's, verbatim",
  );
  assert.equal(posts[0].apiKey, SENTINEL_KEY, "x-goog-api-key was sent");
  assert.match(r.stdout + r.stderr, /FAKE-SENTINEL-7/, "the sentinel operation name came back through the script");
  await fake.close();
});

test("a non-loopback API base is REFUSED, and refused before the key is read", async () => {
  // An endpoint override is a place to send a live credential. It is honoured
  // only for loopback, and the check runs before the key is resolved so a
  // hostile value never has a key to exfiltrate.
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: "https://evil.example.com/v1beta" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /non-loopback/);
  assert.ok(!r.stderr.includes(SENTINEL_KEY), "no key on the refusal path");
});

test("the loopback guard runs BEFORE key resolution — proven by which error fires with no key", async () => {
  // ADDED, and the reason is the signature defect. The test above cannot see
  // the ORDERING it names: `die` prints no key whichever check runs first, so
  // it passes identically with the guard after key resolution. Strip every key
  // source and the two orderings finally disagree — guard-first says
  // "non-loopback", key-first says "no API key".
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], {
    base: "https://evil.example.com/v1beta",
    // HOME is redirected so ~/.gemini/api_key cannot resolve either.
    env: { GEMINI_API_KEY: "", NANOBANANA_API_KEY: "", HOME: mkdtempSync(join(tmpdir(), "nohome-")) },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /non-loopback/, "the base was refused first");
  assert.doesNotMatch(r.stderr, /no API key/, "the key was never even looked for");
});

test("Veo takes 16:9 and 9:16 ONLY — anything else dies before the POST", async (t) => {
  const fake = await fakeFor(t, {});
  const f = fixture();
  for (const bad of ["1:1", "21:9", "4:5"]) {
    const r = await runScript(["x", "-i", f.still, "-a", bad, "-o", f.out], { base: fake.url });
    assert.equal(r.code, 1, `aspect ${bad} must be refused`);
    assert.match(r.stderr, /16:9|9:16/);
  }
  const ok = await runScript(["x", "-i", f.still, "-a", "9:16", "-o", f.out], { base: fake.url });
  assert.notEqual(ok.code, 1, "9:16 is legal and must NOT be refused");
  assert.equal(fake.requests.filter((q) => q.method === "POST").length, 1, "only the legal aspect spent a call");
  await fake.close();
});

test("duration is 4|6|8, and 1080p/4k require 8", async (t) => {
  const fake = await fakeFor(t, {});
  const f = fixture();
  const five = await runScript(["x", "-i", f.still, "-d", "5", "-o", f.out], { base: fake.url });
  assert.equal(five.code, 1);
  const hd4 = await runScript(["x", "-i", f.still, "-r", "1080p", "-d", "4", "-o", f.out], { base: fake.url });
  assert.equal(hd4.code, 1, "1080p at 4s is not a documented combination");
  assert.match(hd4.stderr, /8/);
  const hd8 = await runScript(["x", "-i", f.still, "-r", "1080p", "-d", "8", "-o", f.out], { base: fake.url });
  assert.notEqual(hd8.code, 1, "1080p at 8s is legal");
  assert.equal(fake.requests.filter((q) => q.method === "POST").length, 1, "the two refusals spent nothing");
  await fake.close();
});

test("the Lite model is 1080p only", async (t) => {
  const fake = await fakeFor(t, {});
  const f = fixture();
  const r = await runScript(
    ["x", "-i", f.still, "-m", "veo-3.1-lite-generate-preview", "-r", "720p", "-o", f.out],
    { base: fake.url },
  );
  assert.equal(r.code, 1);
  assert.equal(fake.requests.length, 0, "refused before any request");
  await fake.close();
});

test("NO CONVERTER, NO CALL — a missing webp converter costs zero", async (t) => {
  // The negative control that matters most in this task: the preflight must fire
  // BEFORE the metered POST, so the observation is the EMPTY request log.
  //
  // The PATH is built from symlinks rather than trimmed to /usr/bin, so this is
  // deterministic on a host whose sips CAN make webp: the script needs python3,
  // curl and the coreutils it calls, and gets exactly those and no converter.
  const fake = await fakeFor(t, {});
  const f = fixture();
  const bareBin = mkdtempSync(join(tmpdir(), "nobin-"));
  for (const tool of ["bash", "python3", "curl", "mktemp", "head", "wc", "cut", "tr", "rm", "mv", "mkdir", "date", "sleep"]) {
    const real = execFileSync("/usr/bin/which", [tool], { encoding: "utf8" }).trim();
    if (real !== "") symlinkSync(real, join(bareBin, tool));
  }
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url, env: { PATH: bareBin } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /webp/i);
  assert.equal(fake.requests.length, 0, "THE POINT: not one request was made");
  await fake.close();
});
