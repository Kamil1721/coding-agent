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

test("THE HARD TIMEOUT — an operation that never finishes exits 2, having actually polled", async (t) => {
  // Trap 1. The script blocks BY DESIGN, so a missing deadline is a run that
  // hangs for as long as the operation does. Exit code alone is not enough:
  // "gave up after one GET" and "polled to the deadline" produce the same code
  // and, on a fast machine, the same wall clock. The POLL COUNT is the evidence.
  const fake = await fakeFor(t, { neverDone: true });
  const f = fixture();
  const started = Date.now();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url, timeout: 20_000 });
  const elapsed = Date.now() - started;
  assert.equal(r.killed, false, "the SCRIPT stopped itself; the harness did not have to kill it");
  assert.equal(r.code, 2, "exit 2 is the timeout code and nothing else uses it");
  assert.match(r.stderr, /timed out/i);
  const polls = fake.requests.filter((q) => q.method === "GET" && q.path.includes("FAKE-SENTINEL-7"));
  assert.ok(polls.length >= 2, `expected repeated polling, saw ${polls.length}`);
  assert.ok(elapsed < 12_000, `stopped at its own deadline (${elapsed}ms), not at the harness's`);
  await fake.close();
});

test("a pending operation is waited out, not abandoned", async (t) => {
  const fake = await fakeFor(t, { pollsBeforeDone: 3 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 0, r.stderr);
  const polls = fake.requests.filter((q) => q.method === "GET" && q.path.includes("FAKE-SENTINEL-7"));
  assert.equal(polls.length, 3, "polled until done:true, then stopped polling");
  await fake.close();
});

test("A TRUNCATED DOWNLOAD LEAVES NOTHING BEHIND", async (t) => {
  // Trap 3. The download is a separate curl after the poll returns. An
  // interrupted write leaves an mp4 that looks like a success to existsSync, to
  // the build agent, to the visual gate and to the scorer.
  const fake = await fakeFor(t, { pollsBeforeDone: 1, declaredLength: 5_000_000, truncateDownloadTo: 1_000 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.notEqual(r.code, 0);
  assert.equal(r.code, 4, "exit 4 is the download code");
  assert.equal(existsSync(f.out), false, "no leg-1.mp4 — a partial file is worse than none");
  assert.equal(existsSync(`${f.out}.part`), false, "and no .part left behind either");
  await fake.close();
});

test("THE SIZE FLOOR FIRES ON ITS OWN — a short body that curl calls a clean success", async (t) => {
  // ADDED, and the plan's own prose is the instruction: "if removing both
  // guards does not turn the test red, the fixture is wrong, not the guard".
  //
  // MEASURED on the fixture above: the destroyed socket makes curl exit 18, the
  // `|| METRICS="000 0 0"` fallback discards the real numbers, DL_CODE is 000
  // and the script short-circuits on the HTTP check. The byte-count comparison
  // and the 4096 floor NEVER EXECUTE there. So they are two guards nothing has
  // watched fail -- decoration, in this project's vocabulary.
  //
  // Here Content-Length AGREES with the body, so curl exits 0 and reports 1,000
  // bytes, `wc -c` reports 1,000, the two agree, the ftyp box at offset 4 is
  // present and valid -- and the floor is the only thing left to fail.
  const fake = await fakeFor(t, { pollsBeforeDone: 1, declaredLength: 1_000, truncateDownloadTo: 1_000 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 4, `exit 4, from the floor rather than from the transport: ${r.stderr}`);
  assert.match(r.stderr, /1000 bytes/, "the floor is what reported, naming the byte count it rejected");
  assert.equal(existsSync(f.out), false);
  assert.equal(existsSync(`${f.out}.part`), false);
  await fake.close();
});

test("a complete download is renamed into place and its path printed", async (t) => {
  const fake = await fakeFor(t, { pollsBeforeDone: 1 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(f.out), true);
  assert.match(r.stdout, new RegExp(f.out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readFileSync(f.out).subarray(4, 8).toString(), "ftyp", "it is an mp4, checked here too");
  await fake.close();
});

test("THE KEY IS NEVER PRINTED, even when the server echoes it back at us", async (t) => {
  // The fake server puts the received key straight into its error body. That is
  // what makes this a test of OUR redaction rather than of Google's manners.
  // gemini-image.sh:92 does `cat "$RESP" >&2` on failure -- a sibling that
  // mirrors that shape inherits exactly this leak.
  const fake = await fakeFor(t, { postStatus: 400, echoKeyInError: true });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 3);
  const all = `${r.stdout}\n${r.stderr}`;
  assert.ok(!all.includes(SENTINEL_KEY), "the key must appear in no line of output");
  assert.match(all, /\[REDACTED\]/, "and the redaction must be visible, so a reader knows something was removed");
  assert.match(all, /INVALID_ARGUMENT|400/, "while the diagnosis still survives");
  await fake.close();
});
