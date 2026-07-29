# Phase 2c — The Image→Video Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a DESIGN-lane still into a scroll-scrubbable `.mp4` plus its `.webp` poster, with Veo 3.1 on the same Gemini key, bounded in cost and in time, and never leaving a half-written video on disk that a later step reads as a success.

**Architecture:** One new shell script outside the repo (`~/.claude/scripts/gemini-video.sh`), a deliberate sibling of `gemini-image.sh`, that blocks until the mp4 is on disk. Three new server modules inside the repo — a capability probe, a leg planner with a hard 2-leg cap enforced at the spending seam, and a lane that invokes the script, records what was spent, and injects the §7.6.4 consumption pattern into the build agents' prompts. Every network path is exercised against a local fake Veo server whose request log is what proves the test actually ran.

**Tech Stack:** bash + curl + python3 + cwebp (macOS `sips` fallback, see CONCERN 3); TypeScript 5.9.3, Node ≥24, `node:test`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-orchestration-canvas-design.md` §7.6, §7.6.1, §7.6.2, §7.6.3, §7.6.4, and §7.1a (staging). Touches §7.5 (metered-call note) and §6.2 (no *unrecorded* input).

**Phase-label drift, stated once so the next reader is not misled.** The spec's own numbering drifted from what was built. Spec **§8** is headed "Phase 2b — Anti-slop enforcement" but shipped on 2026-07-29 as **Phase 2a** (`docs/superpowers/plans/2026-07-29-phase-2a-antislop-hooks.md`). Spec **§7** is what is now called **Phase 2b** (the DESIGN lane — stills, manifest, design lock-in), and it is **not built yet**: `visual-criteria.ts:58-68` carries a deliberately minimal `DesignManifest` with a comment saying Phase 2b owns the full one. This plan is **Phase 2c** in the §12 order. Current labels are used throughout.

## Global Constraints

Values marked **[verbatim]** are copied from the spec unchanged. Do not "improve" one.

- **[verbatim §7.6]** Veo 3.1 via the Gemini API — **the same key, same provider, same resolution order as `gemini-image.sh`. No new credential, no third-party service.**
- **[verbatim §7.6.2]** Key resolution order: `$GEMINI_API_KEY` → `$NANOBANANA_API_KEY` → `~/.gemini/api_key`.
- **[verbatim §7.6.1]** Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning`, header `x-goog-api-key: $GEMINI_API_KEY`.
- **[verbatim §7.6.1]** Poll: `GET https://generativelanguage.googleapis.com/v1beta/{operation_name}` until `done:true`.
- **[verbatim §7.6.1]** Download path in the response: `.response.generateVideoResponse.generatedSamples[0].video.uri`.
- **[verbatim §7.6.1]** Models: `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview`.
- **[verbatim §7.6.1]** Aspect: **`16:9` (default), `9:16` only.**
- **[verbatim §7.6.1]** Duration: `4`, `6`, `8` s — **8 s required for 1080p/4k or reference images.**
- **[verbatim §7.6.1]** Resolution: `720p` (default), `1080p`, `4k` (Lite: 1080p only).
- **[verbatim §7.6.2]** The script **blocks until done**, polling internally with a hard timeout. *An agent must never burn turns polling a long-running operation.*
- **[verbatim §7.6.2]** It **emits the poster too** — a `.webp` derived from the source still. The still **is** the first frame, so this is a downscale/convert, **not** a frame extraction.
- **[verbatim §7.6.3.2]** **At most 2 video legs per run, by default.** Raising it is a per-run, recorded opt-in.
- **[verbatim §7.6.3.3]** Audio is generated and **ignored**. Playback is `muted` + `playsInline`. **Do not build on the audio track.**
- **[verbatim §7.6.3.1]** Any section marked `animate` is generated at a Veo-compatible aspect **from the start**.
- **[verbatim §7.5]** Never echo the key into a prompt, log line, or canvas node.
- **[verbatim §7.5]** `costUsd` stays `null` for build/gate/judge; metered spend is tracked on its own line.
- **[verbatim §7.5]** `gemini-image.sh:43` does `mktemp -d` in the *system* temp dir while `allowWrite` is `[workspace]`. The sibling inherits this: **the caller sets `TMPDIR` inside the workspace.** Task 8 does it and tests it.
- `~/.claude/scripts/gemini-video.sh` lives **outside the repository** and git will not record it. §6.2's rule is "no *unrecorded* input", so its **sha256 is recorded per run** alongside the capability flag (Task 6, Task 8).
- Never `git add` a directory, `-A` or `.`. Never `git commit --amend`. No AI-attribution trailer. Never `git push`.
- Do not edit `dashboard/server/src/verdict.ts`, `run-report.ts`, `spec-assumptions.ts`, `orchestrator.ts` beyond the single anchored call site in Task 8, `calibration.test.ts`, `calibration/fixtures.ts`, `bakeoff/**`, `dashboard/STATUS.md`, `bakeoff/STATUS.md`.

---

## THE TRAP — read this before writing any code

**This is the most expensive call in the system and the easiest to leave running.** A video leg costs
real money on a metered key that survives env-stripping by design (`subprocess-env.ts:39-55` does not
list `GEMINI_API_KEY` or `NANOBANANA_API_KEY`, and spec §7.5 records that as intended), and it takes
minutes rather than seconds. Every other lane in this system spends quota; this one spends cash.
Three failure modes, each with the test that must be **observed going red**:

1. **An unbounded poll.** The script blocks *by design* — that is §7.6.2's whole point — so a missing
   or wrong hard timeout is not a slow script, it is a run that hangs for as long as the operation
   does, with an agent parked on it. The timeout is a **tested behaviour, not a constant someone
   remembers to set**: Task 3's fake server never returns `done:true`, and the test asserts the
   script exited **2** within the bound **and that the server observed ≥2 polls**. The poll count is
   what separates "timed out while polling" from "gave up after one GET" — those two produce the same
   exit code and the same wall-clock time on a fast machine.

2. **A silent cap breach.** The 2-leg default is a **cost control**, and a cap that lives only in a
   planner while the caller loops the manifest is a cap in name only. Task 7 enforces it in **two**
   places and proves each independently: the planner clamps (mutation A: delete the clamp → the
   count test goes red), and the invoking seam re-clamps against a hand-built over-long plan
   (mutation B: delete the slice → the same count goes to 5 → red). A cap you have not watched fail
   is a comment.

3. **A partial download read as a finished video.** The download is a **separate `curl` after the
   poll returns**. An interrupted write leaves an mp4 on disk that looks like a success to
   `existsSync`, to the build agent, to the visual gate and to the scorer. Task 4 writes to
   `<out>.part`, checks the byte count against `Content-Length` **and** the `ftyp` box at offset 4
   **itself** — not by trusting curl's exit code, which is the same "an external tool honoured my
   option" assumption that made Instance 10 pass every spec while emulating nothing — then renames.
   The negative control is a fake server that declares 5,000,000 bytes and writes 1,000: the script
   must exit non-zero, `leg-1.mp4` must be **absent**, and no `.part` may be left behind.

**A fourth trap, specific to how this plan is tested.** Every negative control below runs against a
local fake Veo server reached through `GEMINI_VIDEO_API_BASE`. If that override were silently
ignored, the script would hit the real Google endpoint with a fake key, get a 401, and exit
non-zero — and the timeout test, the truncation test and the key-leak test would all **pass
identically while proving nothing**. So the fake server records every request it receives, its POST
returns the operation name `models/veo-3.1-generate-preview/operations/FAKE-SENTINEL-7` — a string
Google cannot return — and **Task 1's first test asserts that sentinel reached the script**. Nothing
downstream is trusted until that one is green.

---

## File Structure

| Path | Created / modified | Responsible for |
|---|---|---|
| `~/.claude/scripts/gemini-video.sh` | **create — OUTSIDE THE REPO**, in the owner's global Claude config, beside `gemini-image.sh`. Not committed; its sha256 is recorded per run instead | The whole metered call: flags, key resolution, validation, preflight, poster, POST, poll-with-timeout, atomic download. Deliberately the same *shape* as `gemini-image.sh` so `taste-frontend-expert` uses it the same way |
| `dashboard/server/gemini-video-fake.mjs` | create | A loopback fake Veo endpoint with a **request log**. Every negative control's observation |
| `dashboard/server/gemini-video-harness.mjs` | create | `node:test` suite driving the real script against the fake server. Not part of `npm test` (it spawns bash and binds a port); run explicitly |
| `dashboard/server/src/design/video-capability.ts` | create | `videoCapability()` — script present + key resolves, in the verbatim order. Returns the **source name and the script's sha256, never the key** |
| `dashboard/server/src/design/video-capability.test.ts` | create | The order, the three degradations, and the leak assertion |
| `dashboard/server/src/design/motion-staging.test.ts` | create | **Guards a non-change.** Asserts `decideMotion` still takes no capability argument and still returns `satisfied` for a video-free GSAP build — see CONCERN 2 |
| `dashboard/server/src/design/video-legs.ts` | create | The on-disk manifest reader, the Veo aspect filter, the 2-leg cap, the spending seam, and the spend record |
| `dashboard/server/src/design/video-legs.test.ts` | create | Cap enforcement at both seams, aspect rejection, `costUsd: null` |
| `dashboard/server/src/design/video-lane.ts` | create | Invokes the script per leg with `TMPDIR` inside the workspace, emits one `graph_tool` per leg, writes `results/video.json`, builds the §7.6.4 prompt fragment |
| `dashboard/server/src/design/video-lane.test.ts` | create | Degrade-don't-block, the TMPDIR env, the graph event, the prompt fragment, and that no key reaches either |
| `dashboard/server/src/paths.ts:115-140` | modify | Add `videoRecord` to `RunPaths` / `runPathsFor` |
| `dashboard/server/src/orchestrator.ts` | modify — **one call site**, anchored by `grep -n 'async #buildPhase('` and **not by line number**: four agents are editing this tree and the line will have moved | Call `runVideoLane` before the build agents are prompted, and pass the fragment through |

**Read, never edited:** `~/.claude/scripts/gemini-image.sh` (the shape to mirror), `~/.claude/agents/taste-frontend-expert.md:37-45` (how the sibling is already documented), `dashboard/server/src/builders/antislop-rules.ts:618-729` (`decideMotion` — CONCERN 2), `dashboard/server/src/visual-criteria.ts:58-68` (`DesignManifest`, which Phase 2b owns and this plan does **not** widen), `dashboard/server/src/subprocess-env.ts:39-55`.

**The on-disk manifest shape this plan reads.** Phase 2b **writes** it (§7.2 gives path/section/aspect/intent; §7.6.3.1 adds `animate` and `aspect`). Phase 2c only parses it, tolerantly — a manifest with no `animate` anywhere yields zero legs and the lane degrades:

```json
{ "sections": [
  { "path": "/ws/design-refs/01-hero.png", "section": "hero",
    "aspect": "16:9", "intent": "the world journey opens", "animate": true }
] }
```

---

### Task 1: The fake Veo endpoint, and the proof the script talks to it

**Why first, and why it is not just scaffolding:** every later negative control in this plan is a
statement about a network interaction that must *not* be a real one. If `GEMINI_VIDEO_API_BASE` were
ignored, all of them would pass against a 401 from Google and none of them would mean anything. This
task ends when a sentinel that only the fake server can produce has been observed coming out of the
real script.

**Files:**
- Create: `~/.claude/scripts/gemini-video.sh` (usage banner, flag parsing, key resolution, loopback-guarded base override, the POST, prints the operation name)
- Create: `dashboard/server/gemini-video-fake.mjs`
- Test: `dashboard/server/gemini-video-harness.mjs`

**Interfaces:**
- Produces (bash): `gemini-video.sh "<motion prompt>" -i still.png [-a 16:9] [-d 4] [-r 720p] [-o leg-1.mp4] [-m model]` — flag grammar copied verbatim from spec §7.6.2. Prints, on success, the mp4 path then the poster path, one per line (the sibling `gemini-image.sh:118` prints its output path; this prints both artefacts it produced).
- Produces (bash exit codes): `0` success · `1` usage/validation/preflight · `2` timeout · `3` API error · `4` download failed or truncated. **Distinct codes are load-bearing:** `gemini-image.sh` exits 1 for everything, and with one code the timeout test in Task 3 passes when *validation* is what actually failed.
- Produces (JS): `startFakeVeo(options): Promise<{ url: string; requests: FakeRequest[]; close(): Promise<void> }>` where `FakeRequest = { method: string; path: string; apiKey: string | null }`, and `options = { pollsBeforeDone?: number; neverDone?: boolean; postStatus?: number; postBody?: unknown; truncateDownloadTo?: number | null; declaredLength?: number | null; echoKeyInError?: boolean }`.

- [ ] **Step 1: Write the failing test**

```js
// dashboard/server/gemini-video-harness.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startFakeVeo } from "./gemini-video-fake.mjs";

const SCRIPT = join(process.env.HOME, ".claude", "scripts", "gemini-video.sh");
const SENTINEL_KEY = "SENTINEL-KEY-DO-NOT-PRINT-9f3a";
const run = promisify(execFile);

/** A 4x4 PNG, so `-i` has a real file to base64. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

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

test("THE OVERRIDE TOOK EFFECT — the script reached the fake server, not Google", async () => {
  // Instance 10: an option an external tool silently ignores makes every test
  // under it pass while emulating nothing. FAKE-SENTINEL-7 is an operation name
  // Google cannot return, so seeing it is proof the request went where we said.
  const fake = await startFakeVeo({ pollsBeforeDone: 1 });
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: FAIL with `Cannot find module '.../gemini-video-fake.mjs'`, then once the fake exists, FAIL with `spawn .../gemini-video.sh ENOENT`.

- [ ] **Step 3: Implement**

```js
// dashboard/server/gemini-video-fake.mjs
import { createServer } from "node:http";

export const SENTINEL_OPERATION = "models/veo-3.1-generate-preview/operations/FAKE-SENTINEL-7";

/**
 * A minimal mp4: an `ftyp` box at offset 4, then filler. Enough to be real to
 * `head -c 12`. 8 KB so a complete download clears the script's 4096-byte floor
 * while the truncation fixture's 1,000 bytes does not.
 */
export function fakeMp4(bytes = 8192) {
  const buf = Buffer.alloc(bytes, 0x21);
  buf.writeUInt32BE(bytes, 0);
  buf.write("ftypisom", 4, "ascii");
  return buf;
}

export async function startFakeVeo(options = {}) {
  const {
    pollsBeforeDone = 1,
    neverDone = false,
    postStatus = 200,
    truncateDownloadTo = null,
    declaredLength = null,
    echoKeyInError = false,
  } = options;
  const requests = [];
  let polls = 0;
  let base = "";

  const server = createServer((req, res) => {
    const key = req.headers["x-goog-api-key"] ?? null;
    requests.push({ method: req.method, path: req.url, apiKey: Array.isArray(key) ? key[0] : key });
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST") {
      req.resume();
      if (postStatus !== 200) {
        const message = echoKeyInError ? `invalid key: ${key}` : "bad request";
        return json(postStatus, { error: { code: postStatus, status: "INVALID_ARGUMENT", message } });
      }
      return json(200, { name: SENTINEL_OPERATION });
    }
    if (req.url === `/v1beta/${SENTINEL_OPERATION}`) {
      polls += 1;
      if (neverDone || polls < pollsBeforeDone) return json(200, { name: SENTINEL_OPERATION, done: false });
      return json(200, {
        name: SENTINEL_OPERATION,
        done: true,
        response: {
          generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/download/leg.mp4` } }] },
        },
      });
    }
    if (req.url === "/download/leg.mp4") {
      const full = fakeMp4();
      const declared = declaredLength ?? full.length;
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(declared) });
      res.write(truncateDownloadTo === null ? full : full.subarray(0, truncateDownloadTo));
      return res.destroy(); // a truncated body, closed mid-stream
    }
    return json(404, { error: { code: 404, status: "NOT_FOUND", message: "no route" } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/v1beta`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
```

```bash
#!/usr/bin/env bash
# ~/.claude/scripts/gemini-video.sh — image→video with Veo 3.1 via the Gemini API.
#
# A SIBLING OF gemini-image.sh ON PURPOSE (spec §7.6.2): same key-resolution
# order, same "prompt first, then flags" grammar, same "prints what it produced"
# contract, so taste-frontend-expert uses it the same way it already uses the
# image script (documented in that agent's body at :37-45).
#
# Usage:
#   gemini-video.sh "<motion prompt>" -i still.png [-a 16:9] [-d 4] [-r 720p] [-o leg-1.mp4] [-m model]
#
#   -i  source still — REQUIRED. It is the FIRST FRAME, and the poster is a
#       downscale of it (spec §7.6.2), so there is no frame extraction anywhere.
#   -a  aspect: 16:9 (default) or 9:16 ONLY. Veo takes no other value.
#   -d  duration seconds: 4 (default), 6 or 8.
#   -r  resolution: 720p (default), 1080p, 4k.
#   -o  output mp4                                        (default ./leg-1.mp4)
#   -m  model override    (default $GEMINI_VIDEO_MODEL or veo-3.1-generate-preview)
#
# API key resolution order: $GEMINI_API_KEY, $NANOBANANA_API_KEY, ~/.gemini/api_key
#
# Exit codes — DISTINCT ON PURPOSE. gemini-image.sh exits 1 for everything; with
# one code a timeout test passes when validation is what actually failed.
#   0 ok · 1 usage/validation/preflight · 2 timeout · 3 API error · 4 download bad
set -euo pipefail

die() { echo "gemini-video: $*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: gemini-video.sh \"prompt\" -i still.png [-a 16:9] [-d 4] [-r 720p] [-o leg-1.mp4] [-m model]"
PROMPT="$1"; shift

ASPECT="16:9"
DURATION="4"
RESOLUTION="720p"
OUT="./leg-1.mp4"
MODEL="${GEMINI_VIDEO_MODEL:-veo-3.1-generate-preview}"
REF=""

while getopts "i:a:d:r:o:m:" opt; do
  case "$opt" in
    i) REF="$OPTARG" ;;
    a) ASPECT="$OPTARG" ;;
    d) DURATION="$OPTARG" ;;
    r) RESOLUTION="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    *) die "unknown flag" ;;
  esac
done

# THE ENDPOINT OVERRIDE IS CHECKED BEFORE THE KEY IS READ. An env var that
# redirects the API base is a place to send a live credential; honouring it only
# for loopback, and refusing first, means a hostile value never has a key to send.
API_BASE="${GEMINI_VIDEO_API_BASE:-https://generativelanguage.googleapis.com/v1beta}"
case "$API_BASE" in
  https://generativelanguage.googleapis.com/v1beta) ;;
  http://127.0.0.1:*|http://localhost:*) ;;
  *) die "refusing a non-loopback GEMINI_VIDEO_API_BASE: $API_BASE" ;;
esac

# Key resolution — identical to gemini-image.sh:36-40, spec §7.6.2.
KEY="${GEMINI_API_KEY:-${NANOBANANA_API_KEY:-}}"
if [ -z "$KEY" ] && [ -f "$HOME/.gemini/api_key" ]; then
  KEY="$(tr -d '[:space:]' < "$HOME/.gemini/api_key")"
fi
[ -n "$KEY" ] || die "no API key. Set GEMINI_API_KEY, NANOBANANA_API_KEY, or write the key to ~/.gemini/api_key"

[ -n "$REF" ] || die "-i is required: Veo 3.1 is driven from a still, and that still is the first frame"
[ -f "$REF" ] || die "source still not found: $REF"

TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT
BODY="$TMPDIR_LOCAL/body.json"
RESP="$TMPDIR_LOCAL/resp.json"

python3 - "$PROMPT" "$REF" "$ASPECT" "$RESOLUTION" "$DURATION" > "$BODY" <<'PY'
import base64, json, sys
prompt, ref, aspect, resolution, duration = sys.argv[1:6]
mime = "image/png" if ref.lower().endswith(".png") else "image/jpeg"
with open(ref, "rb") as f:
    data = base64.b64encode(f.read()).decode()
body = {
    "instances": [{"prompt": prompt,
                   "image": {"inlineData": {"mimeType": mime, "data": data}}}],
    "parameters": {"aspectRatio": aspect, "resolution": resolution, "durationSeconds": duration},
}
json.dump(body, sys.stdout)
PY

STATUS="$(curl -sS -o "$RESP" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -H "x-goog-api-key: $KEY" \
  -d @"$BODY" \
  "${API_BASE}/models/${MODEL}:predictLongRunning")" || STATUS="000"
[ "$STATUS" = "200" ] || { echo "gemini-video: predictLongRunning returned HTTP $STATUS" >&2; exit 3; }

OPERATION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name",""))' "$RESP")"
[ -n "$OPERATION" ] || { echo "gemini-video: no operation name in the response" >&2; exit 3; }
echo "gemini-video: operation $OPERATION" >&2
```

**No model fallback chain, and that is deliberate.** `gemini-image.sh:74` walks three models on
failure. Veo must not: Lite is **1080p only** (§7.6.1), so a silent model switch changes the
resolution constraint *and* the price of a call the user did not choose. One model, named, or an
error.

- [ ] **Step 4: Run to verify it passes**

Run: `chmod +x ~/.claude/scripts/gemini-video.sh && node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: PASS — both tests.

- [ ] **Step 5: Commit** (the script itself is outside the repo and is **not** committed; its sha256 is what gets recorded, in Task 6)

```bash
git commit -F - -- dashboard/server/gemini-video-fake.mjs dashboard/server/gemini-video-harness.mjs <<'MSG'
test(video): a loopback fake Veo endpoint, and proof the override takes effect

Every negative control for the image->video script is a claim about a network
interaction that must not be a real one. If GEMINI_VIDEO_API_BASE were ignored
the script would hit Google with a fake key, get a 401, and every one of those
tests would pass while proving nothing. The fake server logs each request and
returns an operation name Google cannot return, so the first test observes the
override actually working before anything is built on it.
MSG
```

---

### Task 2: Refuse before you spend — validation and preflight

**Why this is its own task:** a reviewer can accept a script that talks to the endpoint and still
reject one that will happily POST a `1:1` still Veo cannot accept, or that discovers halfway through
that no webp converter exists — *after* paying for the video.

**Files:**
- Modify: `~/.claude/scripts/gemini-video.sh` (insert the validation and preflight blocks between the key resolution and `mktemp -d`; the converter probe needs the tmpdir, so it goes just after)
- Test: `dashboard/server/gemini-video-harness.mjs`

**Interfaces:**
- Consumes: `runScript`, `fixture`, `startFakeVeo` (Task 1).
- Produces (bash): `probe_converter()` → echoes `cwebp` or `sips`, or exits 1. `make_poster <src.png> <dst.webp>` is Task 5; this task only proves a converter *works*.

- [ ] **Step 1: Write the failing test**

```js
test("Veo takes 16:9 and 9:16 ONLY — anything else dies before the POST", async () => {
  const fake = await startFakeVeo({});
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

test("duration is 4|6|8, and 1080p/4k require 8", async () => {
  const fake = await startFakeVeo({});
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

test("the Lite model is 1080p only", async () => {
  const fake = await startFakeVeo({});
  const f = fixture();
  const r = await runScript(
    ["x", "-i", f.still, "-m", "veo-3.1-lite-generate-preview", "-r", "720p", "-o", f.out],
    { base: fake.url },
  );
  assert.equal(r.code, 1);
  assert.equal(fake.requests.length, 0, "refused before any request");
  await fake.close();
});

test("NO CONVERTER, NO CALL — a missing webp converter costs zero", async () => {
  // The negative control that matters most in this task: the preflight must fire
  // BEFORE the metered POST, so the observation is the EMPTY request log.
  //
  // The PATH is built from symlinks rather than trimmed to /usr/bin, so this is
  // deterministic on a host whose sips CAN make webp: the script needs python3,
  // curl and the coreutils it calls, and gets exactly those and no converter.
  const fake = await startFakeVeo({});
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
```

(`execFileSync` from `node:child_process` and `symlinkSync` from `node:fs` join the harness's imports.)

> **The `sips` half of that last test is not hypothetical — it was measured on this machine.**
> `sips -s format webp in.png --out out.webp` **exits 13 and writes no file** (sips-316, Darwin
> 25.6). Spec §7.6.2 offers `sips` as the built-in macOS option; on this host it is not one. So the
> preflight is a **functional probe** — convert a 1×1 PNG and check the output's `RIFF`/`WEBP`
> magic — not `command -v`. See CONCERN 3. `cwebp` 1.6.0 is present at `/opt/homebrew/bin/cwebp` and
> produces `RIFF....WEBPVP8X`, so on this host the probe selects `cwebp`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: FAIL — `aspect 1:1 must be refused`: `expected 3 to equal 1` (the script POSTs and the fake 404s the unknown model path), and `THE POINT: not one request was made`: `expected 1 to equal 0`.

- [ ] **Step 3: Implement**

```bash
# ── validation, straight off spec §7.6.1's values table ──────────────────────
case "$ASPECT" in
  16:9|9:16) ;;
  *) die "aspect must be 16:9 or 9:16 — Veo accepts no other value (gemini-image.sh's 1:1..21:9 do not apply here)" ;;
esac
case "$DURATION" in
  4|6|8) ;;
  *) die "duration must be 4, 6 or 8 seconds" ;;
esac
case "$RESOLUTION" in
  720p|1080p|4k) ;;
  *) die "resolution must be 720p, 1080p or 4k" ;;
esac
if [ "$RESOLUTION" != "720p" ] && [ "$DURATION" != "8" ]; then
  die "resolution $RESOLUTION requires -d 8 (spec §7.6.1: 8 s required for 1080p/4k)"
fi
case "$MODEL" in
  *lite*) [ "$RESOLUTION" = "1080p" ] || die "the Lite model is 1080p only; got $RESOLUTION" ;;
esac

# ── preflight. python3 is a hard dependency of the sibling too (:48, :97). ────
command -v python3 >/dev/null 2>&1 || die "python3 not found — required to build the request body"
```

…and, immediately after `mktemp -d` and the `trap`:

```bash
# A FUNCTIONAL PROBE, NOT `command -v`. Measured on this host: `sips -s format
# webp` exits 13 and writes NOTHING (sips-316), so a presence check would select
# a converter that cannot convert and the failure would land after the metered
# call. Convert a 1x1 PNG and look at the magic bytes.
probe_converter() {
  local probe_png="$TMPDIR_LOCAL/probe.png" probe_webp="$TMPDIR_LOCAL/probe.webp"
  python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode(
"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQzwAEYwLQ0YbwUgAAAABJRU5ErkJggg=="))' "$probe_png"
  for candidate in cwebp sips; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    rm -f "$probe_webp"
    case "$candidate" in
      cwebp) cwebp -quiet "$probe_png" -o "$probe_webp" >/dev/null 2>&1 || continue ;;
      sips)  sips -s format webp "$probe_png" --out "$probe_webp" >/dev/null 2>&1 || continue ;;
    esac
    if [ -f "$probe_webp" ] && [ "$(head -c 4 "$probe_webp")" = "RIFF" ]; then
      echo "$candidate"; return 0
    fi
  done
  return 1
}
CONVERTER="$(probe_converter)" || die "no working webp converter (tried cwebp, sips) — the poster in §7.6.2 cannot be produced"
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: PASS — six tests.

- [ ] **Step 5: Commit**

```bash
git commit -F - -- dashboard/server/gemini-video-harness.mjs <<'MSG'
test(video): refuse an impossible request before it costs anything

Veo takes 16:9 and 9:16 only, 4|6|8 seconds, and 8 s for 1080p/4k; the Lite
model is 1080p only. All four are checked before the POST, and the assertion in
every case is the fake server's EMPTY request log rather than an exit code.

The converter preflight is a functional probe, not `command -v`: measured on
this host, `sips -s format webp` exits 13 and writes no file, so a presence
check would select a converter that cannot convert and the failure would land
after the metered call.
MSG
```

---

### Task 3: Block, but bounded — the poll loop and the hard timeout

**Trap 1 lives here.** §7.6.2 requires the script to block; this is what stops blocking from meaning
"forever".

**Files:**
- Modify: `~/.claude/scripts/gemini-video.sh` (append the poll loop after the operation name is read)
- Test: `dashboard/server/gemini-video-harness.mjs`

**Interfaces:**
- Consumes: `OPERATION`, `API_BASE`, `KEY` (Task 1); `startFakeVeo({ neverDone })`, `startFakeVeo({ pollsBeforeDone })`.
- Produces (bash): `GEMINI_VIDEO_POLL_SEC` (default `10`, mirroring `gemini-image.sh:81`'s 10 s backoff) and `GEMINI_VIDEO_TIMEOUT_SEC` (default `900`). **Neither default is a spec value** — §7.6.2 says "a hard timeout" without a number. 900 s is chosen because §7.6.3.4 says a leg takes minutes; it is env-overridable and recorded per run in Task 8.
- Produces (bash): `VIDEO_URI`, the value at `.response.generateVideoResponse.generatedSamples[0].video.uri`.

- [ ] **Step 1: Write the failing test**

```js
test("THE HARD TIMEOUT — an operation that never finishes exits 2, having actually polled", async () => {
  // Trap 1. The script blocks BY DESIGN, so a missing deadline is a run that
  // hangs for as long as the operation does. Exit code alone is not enough:
  // "gave up after one GET" and "polled to the deadline" produce the same code
  // and, on a fast machine, the same wall clock. The POLL COUNT is the evidence.
  const fake = await startFakeVeo({ neverDone: true });
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

test("a pending operation is waited out, not abandoned", async () => {
  const fake = await startFakeVeo({ pollsBeforeDone: 3 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 0, r.stderr);
  const polls = fake.requests.filter((q) => q.method === "GET" && q.path.includes("FAKE-SENTINEL-7"));
  assert.equal(polls.length, 3, "polled until done:true, then stopped polling");
  await fake.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: FAIL with `expected 0 to equal 2` on the timeout test (the script exits after the POST, having never polled) and `expected 0 to equal 3` on the second.

**Then, before moving on, the mutation that proves the test can go red for the right reason:** delete
the two `[ "$(date +%s)" -lt "$DEADLINE" ]` lines and re-run. Expected:
`the SCRIPT stopped itself; the harness did not have to kill it: expected true to equal false` —
the harness's own `timeout: 20_000` fires and `killed` is `true`. Restore.

- [ ] **Step 3: Implement**

```bash
POLL_SEC="${GEMINI_VIDEO_POLL_SEC:-10}"
TIMEOUT_SEC="${GEMINI_VIDEO_TIMEOUT_SEC:-900}"
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))

# BLOCKS UNTIL DONE (spec §7.6.2) — an agent must never burn turns polling a
# long-running operation. Bounded, because "blocks until done" without a deadline
# is "hangs for as long as the operation does".
while :; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "gemini-video: timed out after ${TIMEOUT_SEC}s waiting for ${OPERATION}" >&2
    exit 2
  fi
  STATUS="$(curl -sS -o "$RESP" -w '%{http_code}' \
    -H "x-goog-api-key: $KEY" \
    "${API_BASE}/${OPERATION}")" || STATUS="000"
  [ "$STATUS" = "200" ] || { echo "gemini-video: poll returned HTTP $STATUS" >&2; exit 3; }
  STATE="$(python3 - "$RESP" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if d.get("error"):
    print("failed"); raise SystemExit(0)
print("done" if d.get("done") is True else "pending")
PY
)"
  case "$STATE" in
    done) break ;;
    pending) sleep "$POLL_SEC" ;;
    *) echo "gemini-video: the operation reported an error" >&2; exit 3 ;;
  esac
done

VIDEO_URI="$(python3 - "$RESP" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
try:
    print(d["response"]["generateVideoResponse"]["generatedSamples"][0]["video"]["uri"])
except (KeyError, IndexError):
    print("")
PY
)"
[ -n "$VIDEO_URI" ] || { echo "gemini-video: the finished operation carried no video uri" >&2; exit 3; }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: PASS — eight tests. (The "a pending operation is waited out" test now reaches the download step and exits non-zero there until Task 4; assert `r.code === 0` only after Task 4 lands, or accept the two-step: run it now expecting `polls.length === 3` to pass and the exit-code assertion to fail, and finish it in Task 4. **Take the two-step and note it in the commit** — a test written to the finished behaviour is more honest than one loosened to the half-built one.)

- [ ] **Step 5: Commit**

```bash
git commit -F - -- dashboard/server/gemini-video-harness.mjs <<'MSG'
test(video): the poll is bounded, and the bound is observed

The script blocks until the mp4 exists because an agent must never burn turns
polling a long-running operation (spec §7.6.2). That makes a missing deadline a
run that hangs for as long as the operation does. The timeout test asserts exit
2, that the script stopped ITSELF rather than being killed by the harness, and
that the fake server saw at least two polls -- because "gave up after one GET"
and "polled to the deadline" otherwise look identical.

Mutation executed: with the deadline check deleted, the harness had to SIGKILL
the child and `killed` came back true. Restored.
MSG
```

---

### Task 4: A partial download is a failure, not a video — and no failure prints the key

**Trap 3 lives here, and so does the "never echo the key" rule**, because the failure path is where
scripts leak.

**Files:**
- Modify: `~/.claude/scripts/gemini-video.sh` (append the download; replace the two bare `HTTP $STATUS` messages from Tasks 1 and 3 with the redacting reporter)
- Test: `dashboard/server/gemini-video-harness.mjs`

**Interfaces:**
- Consumes: `VIDEO_URI` (Task 3); `startFakeVeo({ truncateDownloadTo, declaredLength, postStatus, echoKeyInError })`.
- Produces (bash): `api_error <http-status>` — prints the HTTP code plus `error.status`/`error.message` **with every occurrence of the key replaced by `[REDACTED]`**, then exits 3. The key is handed to python3 **through the environment, never argv**.

- [ ] **Step 1: Write the failing test**

```js
test("A TRUNCATED DOWNLOAD LEAVES NOTHING BEHIND", async () => {
  // Trap 3. The download is a separate curl after the poll returns. An
  // interrupted write leaves an mp4 that looks like a success to existsSync, to
  // the build agent, to the visual gate and to the scorer.
  const fake = await startFakeVeo({ pollsBeforeDone: 1, declaredLength: 5_000_000, truncateDownloadTo: 1_000 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.notEqual(r.code, 0);
  assert.equal(r.code, 4, "exit 4 is the download code");
  assert.equal(existsSync(f.out), false, "no leg-1.mp4 — a partial file is worse than none");
  assert.equal(existsSync(`${f.out}.part`), false, "and no .part left behind either");
  await fake.close();
});

test("a complete download is renamed into place and its path printed", async () => {
  const fake = await startFakeVeo({ pollsBeforeDone: 1 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(f.out), true);
  assert.match(r.stdout, new RegExp(f.out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readFileSync(f.out).subarray(4, 8).toString(), "ftyp", "it is an mp4, checked here too");
  await fake.close();
});

test("THE KEY IS NEVER PRINTED, even when the server echoes it back at us", async () => {
  // The fake server puts the received key straight into its error body. That is
  // what makes this a test of OUR redaction rather than of Google's manners.
  // gemini-image.sh:92 does `cat "$RESP" >&2` on failure -- a sibling that
  // mirrors that shape inherits exactly this leak.
  const fake = await startFakeVeo({ postStatus: 400, echoKeyInError: true });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 3);
  const all = `${r.stdout}\n${r.stderr}`;
  assert.ok(!all.includes(SENTINEL_KEY), "the key must appear in no line of output");
  assert.match(all, /\[REDACTED\]/, "and the redaction must be visible, so a reader knows something was removed");
  assert.match(all, /INVALID_ARGUMENT|400/, "while the diagnosis still survives");
  await fake.close();
});
```

(`existsSync`, `readFileSync` are added to the harness's `node:fs` import.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: FAIL with `exit 4 is the download code: expected 0 to equal 4` (nothing downloads yet) and
`the key must appear in no line of output` once a naive `cat "$RESP" >&2` is in place.

- [ ] **Step 3: Implement**

The spec's download line, **verbatim** (§7.6.1):

```
curl -L -o leg-N.mp4 -H "x-goog-api-key: $KEY" "<uri>"
```

Two deliberate departures from that literal, both stated rather than slipped in: `-o` targets
`<out>.part` and the file is renamed only after it verifies (trap 3), and `-sS -w` are added so the
transfer's own numbers are readable. Nothing else changes — same method, same header, same `-L`.

```bash
# ── the redacting error reporter. THE KEY REACHES PYTHON VIA THE ENVIRONMENT,
# never argv, so it is not in this process's own command line either. ─────────
api_error() {
  echo "gemini-video: HTTP $1 from the Gemini API" >&2
  GEMINI_VIDEO_KEY_FOR_REDACTION="$KEY" python3 - "$RESP" >&2 <<'PY' || true
import json, os, sys
key = os.environ.get("GEMINI_VIDEO_KEY_FOR_REDACTION", "")
try:
    err = json.load(open(sys.argv[1])).get("error", {})
except Exception:
    err = {}
text = f'{err.get("status", "?")}: {err.get("message", "no message")}'[:800]
if key:
    text = text.replace(key, "[REDACTED]")
sys.stderr.write("gemini-video: " + text + "\n")
PY
  exit 3
}
```

Replace `{ echo "gemini-video: predictLongRunning returned HTTP $STATUS" >&2; exit 3; }` and the
poll's equivalent with `api_error "$STATUS"`.

```bash
# ── download. Atomic by construction: .part, then verify, then rename. ───────
mkdir -p "$(dirname "$OUT")"
PART="${OUT}.part"
rm -f "$PART"
METRICS="$(curl -sS -L -o "$PART" -w '%{http_code} %{size_download} %{size_header}' \
  -H "x-goog-api-key: $KEY" "$VIDEO_URI")" || METRICS="000 0 0"
DL_CODE="$(echo "$METRICS" | cut -d' ' -f1)"
DL_BYTES="$(echo "$METRICS" | cut -d' ' -f2)"

download_failed() {
  rm -f "$PART"
  echo "gemini-video: $*" >&2
  exit 4
}

[ "$DL_CODE" = "200" ] || download_failed "download returned HTTP $DL_CODE"

# THE SIZE CHECK IS OURS, NOT CURL'S. curl exits 18 on a short transfer, but
# resting the whole trap-3 guarantee on another tool honouring an option is the
# assumption that made a whole suite pass while emulating nothing (Instance 10).
# Three checks, and no more: what curl says it transferred against what landed,
# a floor no real leg is under, and the file's own header.
ACTUAL="$(wc -c < "$PART" | tr -d ' ')"
[ "$ACTUAL" = "$DL_BYTES" ] || download_failed "curl reported $DL_BYTES bytes but $ACTUAL landed"
[ "$ACTUAL" -gt 4096 ] || download_failed "downloaded only $ACTUAL bytes — not a video"
head -c 12 "$PART" | python3 -c '
import sys
d = sys.stdin.buffer.read()
sys.exit(0 if len(d) >= 8 and d[4:8] == b"ftyp" else 1)
' || download_failed "the downloaded bytes are not an MP4 (no ftyp box)"

mv "$PART" "$OUT"
```

> **Why the truncation fixture goes red, spelled out so nobody has to guess.** The fake server
> declares 5,000,000 bytes and writes 1,000 before destroying the socket. curl's own
> `%{size_download}` and `wc -c` both read 1,000 — they agree, so the first check passes — and the
> 4096-byte floor is what fails. That is deliberate: the floor is the check that does not depend on
> curl reporting anything honestly, and `fakeMp4()`'s 8 KB default clears it for a complete
> download. If removing both guards does **not** turn the test red, the fixture is wrong, not the
> guard.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: PASS — eleven tests, including Task 3's `r.code === 0` assertion which now completes.

**Two mutations, executed and restored:**
1. Replace the `.part`/verify/`mv` block with the spec's literal `curl -L -o "$OUT" …`. Expected:
   `no leg-1.mp4 — a partial file is worse than none: expected true to equal false`.
2. Replace `api_error` with `cat "$RESP" >&2` — the shape `gemini-image.sh:92` uses today. Expected:
   `the key must appear in no line of output`.

- [ ] **Step 5: Commit**

```bash
git commit -F - -- dashboard/server/gemini-video-harness.mjs <<'MSG'
test(video): a truncated download is a failure, and no failure prints the key

The download is a separate curl after the poll returns, so an interrupted write
leaves an mp4 that reads as a success to every later step. The script writes to
<out>.part, checks the byte count and the ftyp box ITSELF rather than trusting
curl's exit code, and renames only then.

The key-leak test makes the fake server echo the received x-goog-api-key into
its 400 body, so it tests our redaction rather than Google's manners. Both
mutations executed: the spec's literal `curl -o out.mp4` leaves a truncated
file behind, and `cat "$RESP" >&2` -- the shape gemini-image.sh:92 uses --
prints the key. Restored.
MSG
```

---

### Task 5: The poster, produced **before** the metered call

**§7.6.2, verbatim: the still IS the first frame, so this is a downscale/convert, not a frame
extraction.** Which means the poster does not depend on the video at all — and generating it *first*
turns a converter failure from a wasted Veo call into a free one. **The ordering is a cost control,
not a style choice.**

**Files:**
- Modify: `~/.claude/scripts/gemini-video.sh` (insert `make_poster` and its call between the converter probe and the request-body build)
- Test: `dashboard/server/gemini-video-harness.mjs`

**Interfaces:**
- Consumes: `CONVERTER` (Task 2), `REF`, `OUT`.
- Produces (bash): `POSTER="${OUT%.*}-poster.webp"` — from spec §7.1's observed `leg-1-poster.webp` beside `leg-1.mp4`. `make_poster <src> <dst>` writes it or exits 1.

- [ ] **Step 1: Write the failing test**

```js
test("the poster is emitted beside the mp4, and it is a real webp", async () => {
  const fake = await startFakeVeo({ pollsBeforeDone: 1 });
  const f = fixture();
  const r = await runScript(["x", "-i", f.still, "-o", f.out], { base: fake.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(f.poster), true, "leg-1-poster.webp, the name the reference site uses");
  const head = readFileSync(f.poster).subarray(0, 12);
  assert.equal(head.subarray(0, 4).toString(), "RIFF", "magic bytes, not an exit code");
  assert.equal(head.subarray(8, 12).toString(), "WEBP");
  assert.match(r.stdout, /-poster\.webp/, "both artefacts are announced");
});

test("A BROKEN CONVERTER COSTS NOTHING — the poster is made before the call", async () => {
  // The still is the first frame, so the poster never needed the video. Making
  // it first means a converter that exits 0 and writes nothing is caught while
  // the request log is still empty. sips on this host exits 13 and writes
  // nothing; a converter that lies about success is the same failure, quieter.
  const fake = await startFakeVeo({ pollsBeforeDone: 1 });
  const f = fixture();
  const liar = mkdtempSync(join(tmpdir(), "liar-"));
  writeFileSync(join(liar, "cwebp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // succeeds, writes nothing
  const r = await runScript(["x", "-i", f.still, "-o", f.out], {
    base: fake.url,
    env: { PATH: `${liar}:${process.env.PATH}` },
  });
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(f.out), false);
  assert.equal(fake.requests.length, 0, "THE POINT: the metered call never happened");
  await fake.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: FAIL with `leg-1-poster.webp, the name the reference site uses: expected false to equal true`.

- [ ] **Step 3: Implement**

```bash
POSTER="${OUT%.*}-poster.webp"

# THE STILL IS THE FIRST FRAME (spec §7.6.2), so the poster is a downscale of the
# INPUT, never an extraction from the output — and therefore it is produced
# BEFORE the metered call. A converter that fails then costs nothing. Sizing is
# from the reference site's observed 77-100 KB posters at 1280 wide (spec §7.1),
# not from a spec value.
make_poster() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  rm -f "$dst"
  case "$CONVERTER" in
    cwebp) cwebp -quiet -q 78 -resize 1280 0 "$src" -o "$dst" >/dev/null 2>&1 || true ;;
    sips)  sips -s format webp -Z 1280 "$src" --out "$dst" >/dev/null 2>&1 || true ;;
  esac
  # THE OUTPUT IS ASSERTED, NOT THE EXIT CODE. Measured: `sips -s format webp`
  # exits 13 and writes nothing on this host, and a stub that exits 0 writes
  # nothing just as quietly.
  [ -f "$dst" ] || die "poster conversion produced no file at $dst (converter: $CONVERTER)"
  [ "$(head -c 4 "$dst")" = "RIFF" ] || die "poster at $dst is not a webp (converter: $CONVERTER)"
}
make_poster "$REF" "$POSTER"
```

and, at the very end of the script, replacing Task 1's `echo … operation` as the success output:

```bash
printf '%s\n%s\n' "$OUT" "$POSTER"
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test /Users/kamilborzecki/Projects/coding-agent/dashboard/server/gemini-video-harness.mjs`
Expected: PASS — thirteen tests.

**Mutation, executed and restored:** move `make_poster "$REF" "$POSTER"` to after the download.
Expected: `THE POINT: the metered call never happened: expected 1 to equal 0`.

- [ ] **Step 5: Commit**

```bash
git commit -F - -- dashboard/server/gemini-video-harness.mjs <<'MSG'
test(video): the poster is a downscale of the input, made before the call

The still IS the first frame (spec §7.6.2), so the poster never depended on the
video. Producing it first means a converter that fails -- or one that exits 0
and writes nothing, which is what sips does for webp on this host -- costs zero
instead of one Veo call. The assertion is the RIFF/WEBP magic, never an exit
code, and the negative control's observation is the fake server's empty request
log.
MSG
```

---

### Task 6: The capability flag — recorded, never echoed; and the motion bar left alone

**Files:**
- Create: `dashboard/server/src/design/video-capability.ts`
- Test: `dashboard/server/src/design/video-capability.test.ts`
- Test: `dashboard/server/src/design/motion-staging.test.ts`

**Interfaces:**
- Consumes: `decideMotion` from `../builders/antislop-rules.js` (Phase 2a) — **read and asserted, never modified.**
- Produces:
```ts
export type VideoKeySource = "GEMINI_API_KEY" | "NANOBANANA_API_KEY" | "~/.gemini/api_key";

export interface VideoCapability {
  readonly available: boolean;
  readonly reason: string;
  readonly scriptPath: string | null;
  /** §6.2: no UNRECORDED input. The script is outside the repo, so its hash is the record. */
  readonly scriptSha256: string | null;
  /** WHICH source resolved. NEVER the value. */
  readonly keySource: VideoKeySource | null;
}

export interface VideoCapabilityDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  /** Returns the file's contents, or null when it does not exist. */
  readonly readFile: (path: string) => string | null;
}

export function videoCapability(deps: VideoCapabilityDeps): VideoCapability;
export function defaultVideoCapabilityDeps(): VideoCapabilityDeps;
```

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design/video-capability.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { videoCapability, type VideoCapabilityDeps } from "./video-capability.js";

const SCRIPT = "/home/u/.claude/scripts/gemini-video.sh";
const KEY = "AIza-SENTINEL-NEVER-PRINT-1234567890";

function deps(over: Partial<{ env: NodeJS.ProcessEnv; files: Record<string, string> }> = {}): VideoCapabilityDeps {
  const files = over.files ?? { [SCRIPT]: "#!/usr/bin/env bash\necho hi\n" };
  return {
    env: over.env ?? {},
    home: "/home/u",
    readFile: (p) => files[p] ?? null,
  };
}

test("resolution order is GEMINI_API_KEY then NANOBANANA_API_KEY then ~/.gemini/api_key", () => {
  assert.equal(
    videoCapability(deps({ env: { GEMINI_API_KEY: KEY, NANOBANANA_API_KEY: "other" } })).keySource,
    "GEMINI_API_KEY",
    "first wins — the same order as gemini-image.sh:36-40",
  );
  assert.equal(videoCapability(deps({ env: { NANOBANANA_API_KEY: KEY } })).keySource, "NANOBANANA_API_KEY");
  assert.equal(
    videoCapability(
      deps({ files: { [SCRIPT]: "#!/bin/sh\n", "/home/u/.gemini/api_key": `  ${KEY}\n` } }),
    ).keySource,
    "~/.gemini/api_key",
    "trimmed, mirroring `tr -d '[:space:]'`",
  );
});

test("no script means no capability, and the reason names the path", () => {
  const c = videoCapability(deps({ env: { GEMINI_API_KEY: KEY }, files: {} }));
  assert.equal(c.available, false);
  assert.equal(c.scriptSha256, null);
  assert.match(c.reason, /gemini-video\.sh/);
});

test("no key means no capability, and the reason names all three sources", () => {
  const c = videoCapability(deps({ env: {} }));
  assert.equal(c.available, false);
  assert.equal(c.keySource, null);
  assert.match(c.reason, /GEMINI_API_KEY/);
  assert.match(c.reason, /NANOBANANA_API_KEY/);
  assert.match(c.reason, /\.gemini\/api_key/);
});

test("THE KEY IS NEVER IN THE RESULT — this object gets serialised into a run record", () => {
  const c = videoCapability(deps({ env: { GEMINI_API_KEY: KEY } }));
  assert.equal(c.available, true);
  const json = JSON.stringify(c);
  assert.ok(!json.includes(KEY), "not the value, at any depth");
  assert.equal(c.keySource, "GEMINI_API_KEY", "the SOURCE is what a reader needs");
});

test("the script is hashed, because git does not record a file outside the repo", () => {
  const c = videoCapability(deps({ env: { GEMINI_API_KEY: KEY } }));
  assert.match(String(c.scriptSha256), /^[0-9a-f]{64}$/);
  const changed = videoCapability(
    deps({ env: { GEMINI_API_KEY: KEY }, files: { [SCRIPT]: "#!/usr/bin/env bash\necho CHANGED\n" } }),
  );
  assert.notEqual(changed.scriptSha256, c.scriptSha256, "a changed script is a changed input (§6.2)");
});
```

```ts
// dashboard/server/src/design/motion-staging.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { decideMotion } from "../builders/antislop-rules.js";

/**
 * THIS FILE GUARDS A NON-CHANGE, AND THAT IS THE POINT.
 *
 * Spec §7.1a asks for the Layer-2 satisfier list to be gated on a capability
 * flag. Phase 2a shipped the staging by DISJUNCTION instead: `decideMotion`
 * already lists scroll-scrubbed video first and unconditionally, and a
 * disjunction cannot demand any one of its terms. See CONCERN 2 in the Phase 2c
 * plan for why implementing §7.1a's mechanism literally would be a REGRESSION —
 * a flag that gates a satisfier list can only ever REMOVE satisfiers, and with
 * capability=false it would fail a hand-authored scroll-scrubbed mp4, which is
 * exactly what the owner's own reference site ships.
 */
test("decideMotion takes no capability argument — the flag must never reach it", () => {
  assert.equal(decideMotion.length, 1, "one parameter: the workspace files, and nothing else");
});

test("the motion bar is satisfied by a video-free build, and 2c does not change that", () => {
  const gsapOnly = [
    { path: "/ws/index.html", text: "<main id='app'></main>" },
    { path: "/ws/main.js", text: "gsap.timeline({ scrollTrigger: { trigger: '#app', scrub: true } })" },
  ];
  assert.equal(decideMotion(gsapOnly).kind, "satisfied");
});

test("scroll-scrubbed video is already a satisfier, so 2c adds nothing to the list", () => {
  const scrubbed = [
    { path: "/ws/index.html", text: "<video id='leg1' muted playsinline></video>" },
    {
      path: "/ws/world.js",
      text: "const p = window.scrollY / h; requestAnimationFrame(() => { video.currentTime = p * 4; });",
    },
  ];
  assert.equal(decideMotion(scrubbed).kind, "satisfied");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/kamilborzecki/Projects/coding-agent/dashboard/server && npx tsc -p tsconfig.json --outDir dist-video && node --test "dist-video/design/*.test.js"`
Expected: FAIL at compile with `error TS2307: Cannot find module './video-capability.js'`.

(`dist-video` is a private outDir so a sibling agent's `npm test` — which builds to `dist/` — is not
disturbed mid-run. `rm -rf dist-video` when done, and never `git add` it.)

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design/video-capability.ts
/**
 * Is the image→video step reachable at all?
 *
 * The same degrade-don't-block posture as `geminiKeyAvailable()` in spec §6.5:
 * a run with no Veo capability produces stills and no legs, and NOTHING blocks.
 * Per spec §7.1a the flag is derived from "whether `gemini-video.sh` is present
 * and a key resolves" — both halves, because a present script with no key fails
 * at the first call and a resolvable key with no script fails at spawn.
 *
 * IT RETURNS THE KEY'S SOURCE AND NEVER ITS VALUE. This object is written into
 * `results/video.json` and may reach a canvas node; spec §7.5 and CLAUDE.md:18
 * both say the key goes into no prompt, log line or node.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type VideoKeySource = "GEMINI_API_KEY" | "NANOBANANA_API_KEY" | "~/.gemini/api_key";

export interface VideoCapability {
  readonly available: boolean;
  readonly reason: string;
  readonly scriptPath: string | null;
  readonly scriptSha256: string | null;
  readonly keySource: VideoKeySource | null;
}

export interface VideoCapabilityDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly readFile: (path: string) => string | null;
}

export function defaultVideoCapabilityDeps(): VideoCapabilityDeps {
  return {
    env: process.env,
    home: process.env["HOME"] ?? "",
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function resolveKeySource(deps: VideoCapabilityDeps): VideoKeySource | null {
  // The order is gemini-image.sh:36-40's, verbatim. Empty string is not a key.
  if ((deps.env["GEMINI_API_KEY"] ?? "").trim() !== "") return "GEMINI_API_KEY";
  if ((deps.env["NANOBANANA_API_KEY"] ?? "").trim() !== "") return "NANOBANANA_API_KEY";
  const onDisk = deps.readFile(join(deps.home, ".gemini", "api_key"));
  if (onDisk !== null && onDisk.replace(/\s/g, "") !== "") return "~/.gemini/api_key";
  return null;
}

export function videoCapability(deps: VideoCapabilityDeps): VideoCapability {
  const scriptPath = join(deps.home, ".claude", "scripts", "gemini-video.sh");
  const source = deps.readFile(scriptPath);
  const keySource = resolveKeySource(deps);
  if (source === null) {
    return {
      available: false,
      reason: `no ${scriptPath} — the image→video step is unavailable and the DESIGN lane produces stills only`,
      scriptPath: null,
      scriptSha256: null,
      keySource,
    };
  }
  const scriptSha256 = createHash("sha256").update(source, "utf8").digest("hex");
  if (keySource === null) {
    return {
      available: false,
      reason:
        "no Gemini key resolved (looked at GEMINI_API_KEY, then NANOBANANA_API_KEY, then ~/.gemini/api_key) " +
        "— the image→video step is unavailable and the DESIGN lane produces stills only",
      scriptPath,
      scriptSha256,
      keySource: null,
    };
  }
  return {
    available: true,
    reason: `gemini-video.sh present; key from ${keySource}`,
    scriptPath,
    scriptSha256,
    keySource,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/kamilborzecki/Projects/coding-agent/dashboard/server && npx tsc -p tsconfig.json --outDir dist-video && node --test "dist-video/design/*.test.js"`
Expected: PASS — eight tests.

**Mutation, executed and restored:** add `readonly key: string;` to `VideoCapability` and populate
it. Expected: `not the value, at any depth: expected false to be true`.

- [ ] **Step 5: Commit**

```bash
git commit -F - -- dashboard/server/src/design/video-capability.ts dashboard/server/src/design/video-capability.test.ts dashboard/server/src/design/motion-staging.test.ts <<'MSG'
feat(video): the capability flag, recorded by source and hash, never by value

Spec §7.1a derives the flag from "gemini-video.sh is present and a key
resolves". Both halves, in gemini-image.sh's verbatim order. The result carries
which SOURCE resolved and the script's sha256 -- the script lives outside the
repo, so git records nothing about it and §6.2's "no unrecorded input" needs a
hash -- and never the key itself, because this object is written into the run
record.

motion-staging.test.ts guards a NON-change: decideMotion already lists
scroll-scrubbed video unconditionally and takes no capability argument. The
tests go red if a later author wires the flag into the satisfier list, which
would be a regression -- see CONCERN 2.
MSG
```

---

### Task 7: The cap, enforced where money is spent

**Trap 2 lives here.** §7.6.3.2 verbatim: *"Bounded by default: at most 2 video legs per run… Raising
it is a per-run, recorded opt-in."*

**Files:**
- Create: `dashboard/server/src/design/video-legs.ts`
- Test: `dashboard/server/src/design/video-legs.test.ts`

**Interfaces:**
- Consumes: `VideoCapability` (Task 6).
- Produces:
```ts
export const VEO_ASPECTS = ["16:9", "9:16"] as const;
export type VeoAspect = (typeof VEO_ASPECTS)[number];
export const DEFAULT_VIDEO_LEG_CAP = 2;

export interface VideoLeg {
  readonly index: number;        // 1-based → leg-1.mp4, matching the reference site
  readonly still: string;        // absolute path to the design still
  readonly section: string;
  readonly aspect: VeoAspect;
  readonly out: string;          // <workspace>/assets/world/leg-N.mp4
  readonly poster: string;       // <workspace>/assets/world/leg-N-poster.webp
}

export interface RejectedSection {
  readonly section: string;
  readonly why: string;
}

export interface VideoLegPlan {
  readonly legs: readonly VideoLeg[];
  readonly cap: number;
  readonly capSource: "default" | "run-opt-in";
  readonly droppedByCap: number;
  readonly rejected: readonly RejectedSection[];
}

export function resolveLegCap(env: NodeJS.ProcessEnv): { cap: number; capSource: "default" | "run-opt-in" };
export function planVideoLegs(manifestJson: unknown, workspace: string, cap: { cap: number; capSource: "default" | "run-opt-in" }): VideoLegPlan;

export type LegInvoker = (leg: VideoLeg) => Promise<{ ok: boolean; detail: string }>;
export interface LegRunSummary {
  readonly attempted: number;
  readonly produced: number;
  readonly failures: readonly string[];
}
export function runVideoLegs(plan: VideoLegPlan, invoke: LegInvoker): Promise<LegRunSummary>;

export interface VideoSpendRecord {
  readonly capability: VideoCapability;
  readonly cap: number;
  readonly capSource: "default" | "run-opt-in";
  readonly model: string;
  readonly resolution: string;
  readonly durationSeconds: number;
  readonly legsAttempted: number;
  readonly legsProduced: number;
  readonly meteredSeconds: number;
  readonly timeoutSeconds: number;
  readonly rejected: readonly RejectedSection[];
  readonly failures: readonly string[];
  /** ALWAYS null. See the comment on `renderVideoSpend`. */
  readonly costUsd: null;
}
export function renderVideoSpend(input: {
  capability: VideoCapability; plan: VideoLegPlan; summary: LegRunSummary;
  model: string; resolution: string; durationSeconds: number; timeoutSeconds: number;
}): VideoSpendRecord;
```

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design/video-legs.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { VideoCapability } from "./video-capability.js";
import {
  DEFAULT_VIDEO_LEG_CAP, planVideoLegs, renderVideoSpend, resolveLegCap, runVideoLegs,
  type VideoLeg, type VideoLegPlan,
} from "./video-legs.js";

const WS = "/ws";

function leg(index: number): VideoLeg {
  return {
    index, still: `/ws/design-refs/0${index}-sec.png`, section: `sec-${index}`, aspect: "16:9",
    out: `/ws/assets/world/leg-${index}.mp4`, poster: `/ws/assets/world/leg-${index}-poster.webp`,
  };
}

function cap(): VideoCapability {
  return {
    available: true, reason: "ok", scriptPath: "/home/u/.claude/scripts/gemini-video.sh",
    scriptSha256: "a".repeat(64), keySource: "GEMINI_API_KEY",
  };
}

function manifest(n: number, aspect = "16:9"): unknown {
  return {
    sections: Array.from({ length: n }, (_, i) => ({
      path: `/ws/design-refs/0${i + 1}-sec.png`,
      section: `sec-${i + 1}`,
      aspect,
      intent: "a leg of the world journey",
      animate: true,
    })),
  };
}

test("THE CAP IS 2 BY DEFAULT — five animate sections yield two legs", () => {
  const plan = planVideoLegs(manifest(5), WS, resolveLegCap({}));
  assert.equal(DEFAULT_VIDEO_LEG_CAP, 2);
  assert.equal(plan.legs.length, 2, "spec §7.6.3.2: at most 2 video legs per run, by default");
  assert.equal(plan.droppedByCap, 3, "and the drop is RECORDED, not silent");
  assert.deepEqual(plan.legs.map((l) => l.index), [1, 2]);
  assert.match(plan.legs[0]!.out, /leg-1\.mp4$/);
  assert.match(plan.legs[0]!.poster, /leg-1-poster\.webp$/);
});

test("THE SPENDING SEAM CAPS TOO, even handed an over-long plan", () => {
  // A cap that lives only in the planner is a cap in name only: any caller that
  // loops the manifest itself walks straight past it. This test hand-builds an
  // INCONSISTENT plan so the planner's clamp cannot mask the seam's.
  const overlong: VideoLegPlan = {
    legs: Array.from({ length: 5 }, (_, i) => leg(i + 1)),
    cap: 2, capSource: "default", droppedByCap: 0, rejected: [],
  };
  const calls: number[] = [];
  return runVideoLegs(overlong, async (l) => { calls.push(l.index); return { ok: true, detail: "" }; })
    .then((summary) => {
      assert.deepEqual(calls, [1, 2], "the invoker ran twice — this is where money is spent");
      assert.equal(summary.attempted, 2);
    });
});

test("raising the cap is an opt-in, and the opt-in is recorded", () => {
  const raised = resolveLegCap({ DASHBOARD_VIDEO_LEG_CAP: "3" });
  assert.deepEqual(raised, { cap: 3, capSource: "run-opt-in" });
  assert.equal(planVideoLegs(manifest(5), WS, raised).legs.length, 3);
  assert.equal(
    renderVideoSpend({
      capability: cap(), plan: planVideoLegs(manifest(5), WS, raised),
      summary: { attempted: 3, produced: 3, failures: [] },
      model: "veo-3.1-generate-preview", resolution: "720p", durationSeconds: 4, timeoutSeconds: 900,
    }).capSource,
    "run-opt-in",
    "an unattended run must be explainable after the fact",
  );
});

test("a junk cap falls back to the default rather than to infinity", () => {
  for (const bad of ["", "0", "-1", "nine", "999999"]) {
    const r = resolveLegCap({ DASHBOARD_VIDEO_LEG_CAP: bad });
    assert.ok(r.cap >= 1 && r.cap <= 8, `${bad} → ${r.cap}`);
  }
});

test("a non-Veo aspect is REJECTED with a reason, never silently resized", () => {
  // Spec §7.6.3.1: gemini-image.sh accepts 1:1..21:9; Veo does not. A section
  // marked animate at 1:1 is a DESIGN-lane mistake and must be reported back,
  // not quietly re-cropped into something the art direction did not choose.
  const plan = planVideoLegs(manifest(2, "1:1"), WS, resolveLegCap({}));
  assert.equal(plan.legs.length, 0);
  assert.equal(plan.rejected.length, 2);
  assert.match(plan.rejected[0]!.why, /16:9|9:16/);
});

test("a manifest with no animate flag yields no legs — Phase 2b writes that field", () => {
  const preV2b = { sections: [{ path: "/ws/design-refs/01.png", section: "hero", aspect: "16:9" }] };
  assert.equal(planVideoLegs(preV2b, WS, resolveLegCap({})).legs.length, 0);
  assert.equal(planVideoLegs(null, WS, resolveLegCap({})).legs.length, 0, "and junk is not a crash");
  assert.equal(planVideoLegs({ sections: "nope" }, WS, resolveLegCap({})).legs.length, 0);
});

test("a failing leg is recorded and does not abort the other one", () => {
  const plan = planVideoLegs(manifest(2), WS, resolveLegCap({}));
  return runVideoLegs(plan, async (l) => l.index === 1
    ? { ok: false, detail: "exit 4: truncated download" }
    : { ok: true, detail: "" },
  ).then((s) => {
    assert.equal(s.attempted, 2);
    assert.equal(s.produced, 1);
    assert.match(s.failures[0]!, /truncated/);
  });
});

test("costUsd is null and no dollar figure is invented", () => {
  const record = renderVideoSpend({
    capability: cap(), plan: planVideoLegs(manifest(2), WS, resolveLegCap({})),
    summary: { attempted: 2, produced: 2, failures: [] },
    model: "veo-3.1-generate-preview", resolution: "720p", durationSeconds: 4, timeoutSeconds: 900,
  });
  assert.equal(record.costUsd, null, "spec §7.5: costUsd stays null; metered spend is its own line");
  assert.equal(record.meteredSeconds, 8, "2 legs × 4 s — UNITS, which are real");
  assert.ok(!JSON.stringify(record).includes("$"), "no invented price: the spec carries no price table");
});
```

(`leg(i)` and `cap()` are two-line local helpers building a `VideoLeg` and an available
`VideoCapability`; write them at the top of the file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/kamilborzecki/Projects/coding-agent/dashboard/server && npx tsc -p tsconfig.json --outDir dist-video && node --test "dist-video/design/*.test.js"`
Expected: FAIL at compile with `error TS2307: Cannot find module './video-legs.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design/video-legs.ts
/**
 * WHAT GETS ANIMATED, AND HOW MANY TIMES — the cost control of spec §7.6.3.2.
 *
 * "Bounded by default: at most 2 video legs per run… Raising it is a per-run,
 * recorded opt-in." A video leg is the most expensive call this system makes,
 * so the bound is enforced TWICE — once when the plan is built and once at the
 * seam that actually invokes the script — and each is proven by counting
 * invocations rather than by reading the plan back.
 *
 * THE MANIFEST IS PARSED, NOT TYPED FROM `DesignManifest`. `visual-criteria.ts`
 * :58-68 says in as many words that Phase 2b owns that type and that a second
 * declaration site would be a merge conflict with a wrong answer in it. This
 * module reads the on-disk JSON tolerantly instead: no `animate` anywhere means
 * no legs, which is exactly the degraded state a pre-2b manifest should produce.
 */
import type { VideoCapability } from "./video-capability.js";

export const VEO_ASPECTS = ["16:9", "9:16"] as const;
export type VeoAspect = (typeof VEO_ASPECTS)[number];

/** Spec §7.6.3.2, and it matches the reference site's leg-1 / leg-2. */
export const DEFAULT_VIDEO_LEG_CAP = 2;
/** An opt-in is a raise, not a blank cheque. */
const MAX_VIDEO_LEG_CAP = 8;

export interface VideoLeg {
  readonly index: number;
  readonly still: string;
  readonly section: string;
  readonly aspect: VeoAspect;
  readonly out: string;
  readonly poster: string;
}
export interface RejectedSection { readonly section: string; readonly why: string }
export interface VideoLegPlan {
  readonly legs: readonly VideoLeg[];
  readonly cap: number;
  readonly capSource: "default" | "run-opt-in";
  readonly droppedByCap: number;
  readonly rejected: readonly RejectedSection[];
}

export function resolveLegCap(env: NodeJS.ProcessEnv): { cap: number; capSource: "default" | "run-opt-in" } {
  const raw = (env["DASHBOARD_VIDEO_LEG_CAP"] ?? "").trim();
  if (raw === "") return { cap: DEFAULT_VIDEO_LEG_CAP, capSource: "default" };
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_VIDEO_LEG_CAP) {
    return { cap: DEFAULT_VIDEO_LEG_CAP, capSource: "default" };
  }
  return { cap: parsed, capSource: "run-opt-in" };
}

function isVeoAspect(value: unknown): value is VeoAspect {
  return typeof value === "string" && (VEO_ASPECTS as readonly string[]).includes(value);
}

export function planVideoLegs(
  manifestJson: unknown,
  workspace: string,
  cap: { cap: number; capSource: "default" | "run-opt-in" },
): VideoLegPlan {
  const sections =
    typeof manifestJson === "object" && manifestJson !== null && Array.isArray((manifestJson as { sections?: unknown }).sections)
      ? ((manifestJson as { sections: unknown[] }).sections)
      : [];
  const rejected: RejectedSection[] = [];
  const legs: VideoLeg[] = [];
  let droppedByCap = 0;
  for (const raw of sections) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (s["animate"] !== true) continue;
    const name = typeof s["section"] === "string" ? s["section"] : "(unnamed section)";
    const still = typeof s["path"] === "string" ? s["path"] : "";
    if (still === "") {
      rejected.push({ section: name, why: "no `path` to a still" });
      continue;
    }
    // Bound to a local before the guard: narrowing an index-signature element
    // access in place is not something to rely on under `strict`.
    const aspect = s["aspect"];
    if (!isVeoAspect(aspect)) {
      rejected.push({
        section: name,
        why: `aspect ${JSON.stringify(aspect)} cannot be animated — Veo takes 16:9 or 9:16 only, so a section marked animate must be GENERATED at one of those (spec §7.6.3.1)`,
      });
      continue;
    }
    if (legs.length >= cap.cap) { droppedByCap += 1; continue; }
    const index = legs.length + 1;
    legs.push({
      index,
      still,
      section: name,
      aspect,
      out: `${workspace}/assets/world/leg-${index}.mp4`,
      poster: `${workspace}/assets/world/leg-${index}-poster.webp`,
    });
  }
  return { legs, cap: cap.cap, capSource: cap.capSource, droppedByCap, rejected };
}

export type LegInvoker = (leg: VideoLeg) => Promise<{ ok: boolean; detail: string }>;
export interface LegRunSummary {
  readonly attempted: number;
  readonly produced: number;
  readonly failures: readonly string[];
}

/**
 * THE SEAM WHERE MONEY IS SPENT, AND THEREFORE THE SECOND PLACE THE CAP LIVES.
 * `plan.legs` is already clamped; this slice is not redundancy for its own sake.
 * A future caller that builds a plan by hand, or a planner regression, would
 * otherwise turn the cap into a comment.
 *
 * SEQUENTIAL, NOT PARALLEL: each call is minutes long and metered, and two in
 * flight double the blast radius of a wrong prompt before anyone can look.
 */
export async function runVideoLegs(plan: VideoLegPlan, invoke: LegInvoker): Promise<LegRunSummary> {
  const legs = plan.legs.slice(0, plan.cap);
  const failures: string[] = [];
  let produced = 0;
  for (const leg of legs) {
    const result = await invoke(leg);
    if (result.ok) produced += 1;
    else failures.push(`leg-${leg.index} (${leg.section}): ${result.detail}`);
  }
  return { attempted: legs.length, produced, failures };
}

export interface VideoSpendRecord {
  readonly capability: VideoCapability;
  readonly cap: number;
  readonly capSource: "default" | "run-opt-in";
  readonly model: string;
  readonly resolution: string;
  readonly durationSeconds: number;
  readonly legsAttempted: number;
  readonly legsProduced: number;
  readonly meteredSeconds: number;
  readonly timeoutSeconds: number;
  readonly rejected: readonly RejectedSection[];
  readonly failures: readonly string[];
  readonly costUsd: null;
}

/**
 * METERED SPEND ON ITS OWN LINE, IN UNITS, WITH NO INVENTED PRICE.
 *
 * Spec §7.5: `costUsd` stays null for build/gate/judge and design-lane spend is
 * tracked separately. It is tracked here as seconds of Veo at a named model and
 * resolution — numbers this program actually knows. NO DOLLAR FIGURE IS
 * PRODUCED, because the spec carries no Veo price table and a made-up rate is a
 * fabricated bill, which is the exact failure `costUsd: null` exists to prevent.
 */
export function renderVideoSpend(input: {
  capability: VideoCapability; plan: VideoLegPlan; summary: LegRunSummary;
  model: string; resolution: string; durationSeconds: number; timeoutSeconds: number;
}): VideoSpendRecord {
  return {
    capability: input.capability,
    cap: input.plan.cap,
    capSource: input.plan.capSource,
    model: input.model,
    resolution: input.resolution,
    durationSeconds: input.durationSeconds,
    legsAttempted: input.summary.attempted,
    legsProduced: input.summary.produced,
    meteredSeconds: input.summary.produced * input.durationSeconds,
    timeoutSeconds: input.timeoutSeconds,
    rejected: input.plan.rejected,
    failures: input.summary.failures,
    costUsd: null,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/kamilborzecki/Projects/coding-agent/dashboard/server && npx tsc -p tsconfig.json --outDir dist-video && node --test "dist-video/design/*.test.js"`
Expected: PASS — sixteen tests.

**Two mutations, executed and restored — trap 2's negative control:**
1. Delete `if (legs.length >= cap.cap) { droppedByCap += 1; continue; }`. Expected:
   `spec §7.6.3.2: at most 2 video legs per run, by default: expected 5 to equal 2`.
2. Change `plan.legs.slice(0, plan.cap)` to `plan.legs`. Expected:
   `the invoker ran twice — this is where money is spent: expected [1,2,3,4,5] to deeply equal [1,2]`.

Each mutation must fail **on its own**. If mutation 1 leaves the suite green, the two enforcement
points are not independent and the test is testing the wrong seam.

- [ ] **Step 5: Commit**

```bash
git commit -F - -- dashboard/server/src/design/video-legs.ts dashboard/server/src/design/video-legs.test.ts <<'MSG'
feat(video): the 2-leg cap, enforced where money is actually spent

Spec §7.6.3.2 bounds a run at 2 video legs by default and makes raising it a
recorded opt-in. A cap that lives only in the planner is a cap in name only, so
it is enforced again at the invoking seam and both are proven by COUNTING
invocations against a stub -- one test hands the seam a deliberately
inconsistent five-leg plan so the planner's clamp cannot mask it. Both
mutations executed and each fails on its own.

A section marked animate at a non-Veo aspect is rejected with a reason rather
than silently re-cropped (§7.6.3.1). costUsd stays null and spend is recorded
in SECONDS: the spec carries no Veo price table and a made-up rate would be a
fabricated bill.
MSG
```

---

### Task 8: The lane — invoke, record, tell the build agents how to consume it

**Files:**
- Create: `dashboard/server/src/design/video-lane.ts`
- Test: `dashboard/server/src/design/video-lane.test.ts`
- Modify: `dashboard/server/src/paths.ts:115-140` (add `videoRecord` to `RunPaths` and `runPathsFor`)
- Modify: `dashboard/server/src/orchestrator.ts` — **one call site**, located with
  `grep -n 'async #buildPhase(' dashboard/server/src/orchestrator.ts`. **Do not trust a line number
  here**: four agents are editing this tree and `#buildPhase` was at `:525` when this plan was
  written, which it will not be by the time it is implemented.

**Interfaces:**
- Consumes: `videoCapability`, `defaultVideoCapabilityDeps` (Task 6); `planVideoLegs`, `resolveLegCap`, `runVideoLegs`, `renderVideoSpend`, `VideoLeg`, `VideoSpendRecord` (Task 7); `GraphSseEvent` from `../api-types.js`; `subscriptionSubprocessEnv` from `../subprocess-env.js`; the script CLI from Task 1.
- Produces:
```ts
export interface VideoLaneDeps {
  readonly workspace: string;
  readonly recordPath: string;
  readonly node: string;                       // the graph node this lane runs under
  readonly env: NodeJS.ProcessEnv;
  readonly capability: VideoCapability;
  readonly readManifest: () => unknown;        // parsed design-refs/manifest.json, or null
  readonly spawnLeg: (leg: VideoLeg, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail: string }>;
  readonly emitGraph: (event: GraphSseEvent) => void;
  readonly writeRecord: (path: string, json: string) => void;
}
export function defaultSpawnLeg(scriptPath: string): VideoLaneDeps["spawnLeg"];
export function videoLaneEnv(env: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv;
export function videoConsumptionPrompt(legs: readonly VideoLeg[]): string;
export function runVideoLane(deps: VideoLaneDeps): Promise<{ record: VideoSpendRecord; prompt: string }>;
```

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design/video-lane.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { GraphSseEvent } from "../api-types.js";
import type { VideoCapability } from "./video-capability.js";
import { runVideoLane, videoConsumptionPrompt, videoLaneEnv, type VideoLaneDeps } from "./video-lane.js";

const KEY = "AIza-SENTINEL-NEVER-PRINT-1234567890";
const AVAILABLE: VideoCapability = {
  available: true, reason: "ok", scriptPath: "/home/u/.claude/scripts/gemini-video.sh",
  scriptSha256: "a".repeat(64), keySource: "GEMINI_API_KEY",
};
const MANIFEST = {
  sections: [
    { path: "/ws/design-refs/01.png", section: "descent", aspect: "16:9", intent: "i", animate: true },
    { path: "/ws/design-refs/02.png", section: "arrival", aspect: "16:9", intent: "i", animate: true },
    { path: "/ws/design-refs/03.png", section: "outro", aspect: "16:9", intent: "i", animate: true },
  ],
};

function deps(over: Partial<VideoLaneDeps> = {}): { d: VideoLaneDeps; events: GraphSseEvent[]; written: string[]; spawned: string[] } {
  const events: GraphSseEvent[] = [];
  const written: string[] = [];
  const spawned: string[] = [];
  const d: VideoLaneDeps = {
    workspace: "/ws", recordPath: "/runs/r1/results/video.json", node: "n7",
    env: { GEMINI_API_KEY: KEY }, capability: AVAILABLE,
    readManifest: () => MANIFEST,
    spawnLeg: async (leg) => { spawned.push(leg.out); return { ok: true, detail: "" }; },
    emitGraph: (e) => events.push(e),
    writeRecord: (_p, json) => written.push(json),
    ...over,
  };
  return { d, events, written, spawned };
}

test("the lane runs two legs, records them, and writes the spend line", async () => {
  const { d, written, spawned } = deps();
  const { record } = await runVideoLane(d);
  assert.equal(spawned.length, 2, "the cap holds through the lane, not just the planner");
  assert.equal(record.legsProduced, 2);
  assert.equal(record.costUsd, null);
  assert.equal(written.length, 1);
  assert.match(written[0]!, /"legsProduced": *2/);
});

test("NO CAPABILITY DEGRADES, IT DOES NOT BLOCK — and it still leaves a record", async () => {
  // Same posture as §6.5's geminiKeyAvailable(): blocking a build on an absent
  // key is a worse failure than shipping without the video.
  const { d, spawned, written } = deps({
    capability: { available: false, reason: "no key resolved", scriptPath: null, scriptSha256: null, keySource: null },
  });
  const { record, prompt } = await runVideoLane(d);
  assert.equal(spawned.length, 0, "nothing was spawned");
  assert.equal(record.legsProduced, 0);
  assert.equal(written.length, 1, "a degraded lane is still explainable after the fact");
  assert.equal(prompt, "", "and the build agents are told nothing about legs that do not exist");
});

test("THE CANVAS SEES A LONG-RUNNING LEG START", async () => {
  // Spec §7.6.3.4: a leg takes minutes, and without an event the canvas looks
  // stalled. graph_tool is emitted at launch, not at completion, because a
  // completion-only event is exactly the silence being fixed.
  const { d, events } = deps();
  await runVideoLane(d);
  // A TYPE PREDICATE, not a bare boolean: `summary` and `node` do not exist on
  // every GraphSseEvent member, so a plain `.filter` leaves the union unnarrowed
  // and this file does not compile.
  const tools = events.filter(
    (e): e is Extract<GraphSseEvent, { type: "graph_tool" }> => e.type === "graph_tool",
  );
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.node, "n7");
  assert.match(tools[0]!.summary, /minutes/i, "the caption says this is slow ON PURPOSE");
  assert.match(tools[0]!.summary, /leg-1/);
  assert.ok(!JSON.stringify(events).includes(KEY), "and no key on the canvas (§7.5, CLAUDE.md:18)");
});

test("TMPDIR IS MOVED INSIDE THE WORKSPACE, and the key is NOT stripped", () => {
  // Spec §7.5 row 1: the script does `mktemp -d` in the SYSTEM temp dir while
  // sandbox allowWrite is [workspace]. "Most likely silent breakage."
  const env = videoLaneEnv({ GEMINI_API_KEY: KEY, ANTHROPIC_API_KEY: "nope", TMPDIR: "/var/folders/x" }, "/ws");
  assert.match(String(env["TMPDIR"]), /^\/ws\//);
  assert.equal(env["GEMINI_API_KEY"], KEY, "deliberately NOT in STRIPPED_ENV_NAMES — spec §7.5");
  assert.equal(env["ANTHROPIC_API_KEY"], undefined, "the subscription invariant still holds");
});

test("the consumption prompt is §7.6.4's pattern, with the real paths in it", () => {
  const p = videoConsumptionPrompt([
    { index: 1, still: "/ws/design-refs/01.png", section: "descent", aspect: "16:9",
      out: "/ws/assets/world/leg-1.mp4", poster: "/ws/assets/world/leg-1-poster.webp" },
  ]);
  assert.match(p, /\/ws\/assets\/world\/leg-1\.mp4/, "absolute paths are what make a Read/fetch happen");
  assert.match(p, /leg-1-poster\.webp/);
  assert.match(p, /fetch/);
  assert.match(p, /blob:/);
  assert.match(p, /muted/);
  assert.match(p, /playsInline/);
  assert.match(p, /currentTime/);
  assert.match(p, /requestAnimationFrame|rAF/);
  assert.match(p, /object-fit: *cover|objectFit/);
  assert.match(p, /no autoplay/i);
  assert.match(p, /no loop/i);
  assert.match(p, /scrub, do not play/i);
  assert.match(p, /audio/i, "§7.6.3.3: audio is generated and IGNORED — say so, or someone builds on it");
  assert.ok(!p.includes(KEY));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/kamilborzecki/Projects/coding-agent/dashboard/server && npx tsc -p tsconfig.json --outDir dist-video && node --test "dist-video/design/*.test.js"`
Expected: FAIL at compile with `error TS2307: Cannot find module './video-lane.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design/video-lane.ts
/**
 * The image→video lane: plan, spend, record, and hand the build agents the one
 * thing they cannot infer — HOW to consume an mp4 that is meant to be scrubbed.
 *
 * DEGRADE, DO NOT BLOCK. No capability, no manifest, or no `animate` section
 * all produce a record and an empty prompt. Spec §6.5's posture, verbatim:
 * blocking a build on an absent image key is a worse failure than shipping
 * without mockups, and the same is true of video.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GraphSseEvent } from "../api-types.js";
import { subscriptionSubprocessEnv } from "../subprocess-env.js";
import type { VideoCapability } from "./video-capability.js";
import {
  planVideoLegs, renderVideoSpend, resolveLegCap, runVideoLegs,
  type VideoLeg, type VideoSpendRecord,
} from "./video-legs.js";

const MODEL = "veo-3.1-generate-preview";
const RESOLUTION = "720p";
/** 4 s at 720p — spec §7.6: the reference site's legs are 4.04 s at 1280×720. */
const DURATION_SECONDS = 4;
const TIMEOUT_SECONDS = 900;

export interface VideoLaneDeps {
  readonly workspace: string;
  readonly recordPath: string;
  readonly node: string;
  readonly env: NodeJS.ProcessEnv;
  readonly capability: VideoCapability;
  readonly readManifest: () => unknown;
  readonly spawnLeg: (leg: VideoLeg, env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail: string }>;
  readonly emitGraph: (event: GraphSseEvent) => void;
  readonly writeRecord: (path: string, json: string) => void;
}

/**
 * TMPDIR IS MOVED INSIDE THE WORKSPACE, and that is spec §7.5's "most likely
 * silent breakage" for the image sibling, inherited here verbatim: the script
 * does `mktemp -d` in the SYSTEM temp dir while `sandbox.filesystem.allowWrite`
 * is `[workspace]`.
 *
 * GEMINI_API_KEY SURVIVES, ON PURPOSE. It is absent from STRIPPED_ENV_NAMES
 * (`subprocess-env.ts:39-55`, "a subtraction, never an allowlist") and spec §7.5
 * records that as intended — this lane is the metered spend the note is about.
 */
export function videoLaneEnv(env: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv {
  return { ...subscriptionSubprocessEnv(env), TMPDIR: join(workspace, ".tmp") };
}

export function defaultSpawnLeg(scriptPath: string): VideoLaneDeps["spawnLeg"] {
  const run = promisify(execFile);
  return async (leg, env) => {
    try {
      await run(
        scriptPath,
        [
          motionPromptFor(leg), "-i", leg.still, "-a", leg.aspect,
          "-d", String(DURATION_SECONDS), "-r", RESOLUTION, "-o", leg.out, "-m", MODEL,
        ],
        { env, timeout: (TIMEOUT_SECONDS + 60) * 1000, killSignal: "SIGKILL" },
      );
      return { ok: true, detail: "" };
    } catch (error) {
      // The script already redacts; this carries only its exit code and stderr,
      // which the key-leak test in the harness covers.
      const e = error as { code?: number; stderr?: string };
      return { ok: false, detail: `exit ${e.code ?? "?"}: ${(e.stderr ?? "").slice(0, 500)}` };
    }
  };
}

function motionPromptFor(leg: VideoLeg): string {
  return (
    `A slow, continuous camera move through this exact scene, holding its palette, lighting and ` +
    `composition. No cuts, no new subjects, no text. The first frame is the supplied still. ` +
    `Section: ${leg.section}.`
  );
}

/** Spec §7.6.4, taken from the reference site's runtime behaviour, not invented. */
export function videoConsumptionPrompt(legs: readonly VideoLeg[]): string {
  if (legs.length === 0) return "";
  const list = legs
    .map((l) => `  leg ${l.index} (${l.section}): ${l.out}\n    poster: ${l.poster}`)
    .join("\n");
  return [
    "SCROLL-SCRUBBED WORLD LAYER — implement exactly this pattern. It is measured from the",
    "reference site's runtime behaviour, not invented, and it is what the motion bar accepts.",
    "",
    list,
    "",
    "  fetch(mp4) -> blob: URL -> <video muted playsInline preload paused, no autoplay, no loop>",
    "  poster=<leg-N-poster.webp>                       instant first paint",
    "  rAF loop: video.currentTime = f(scrollProgress)   scrub, do not play",
    "  layers: position:absolute, object-fit:cover       full-bleed world",
    "",
    "The fetch->blob step is what makes seeking instant; a plain <video src> streams and scrubs",
    "badly. Do not call play(). Do not set loop.",
    "AUDIO IS GENERATED AND IGNORED: Veo 3.1 produces a native audio track and playback is muted",
    "and playsInline. Do not build on the audio track — no waveform, no sync, no unmute control.",
  ].join("\n");
}

export async function runVideoLane(deps: VideoLaneDeps): Promise<{ record: VideoSpendRecord; prompt: string }> {
  const cap = resolveLegCap(deps.env);
  const plan = deps.capability.available
    ? planVideoLegs(deps.readManifest(), deps.workspace, cap)
    : { legs: [], cap: cap.cap, capSource: cap.capSource, droppedByCap: 0, rejected: [] };
  const env = videoLaneEnv(deps.env, deps.workspace);
  const summary = await runVideoLegs(plan, async (leg) => {
    // EMITTED AT LAUNCH, NOT AT COMPLETION (spec §7.6.3.4). A leg takes minutes;
    // an event that only arrives at the end is the silence being fixed.
    deps.emitGraph({
      type: "graph_tool",
      node: deps.node,
      name: "gemini-video.sh",
      mcpServer: null,
      summary: `generating leg-${leg.index} (${leg.section}) — a Veo 3.1 leg takes minutes, not seconds`,
      attribution: "exact",
    });
    return deps.spawnLeg(leg, env);
  });
  const record = renderVideoSpend({
    capability: deps.capability, plan, summary,
    model: MODEL, resolution: RESOLUTION, durationSeconds: DURATION_SECONDS, timeoutSeconds: TIMEOUT_SECONDS,
  });
  deps.writeRecord(deps.recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { record, prompt: videoConsumptionPrompt(plan.legs) };
}
```

`paths.ts` — one field, inside `RunPaths` and `runPathsFor`:

```ts
  /** Metered image→video spend, in units. `costUsd` stays null; see api-types.ts. */
  readonly videoRecord: string;
```
```ts
    videoRecord: join(root, "results", "video.json"),
```

`orchestrator.ts` — at the site found by `grep -n 'async #buildPhase('`, before the build agents are
prompted:

```ts
    const capability = videoCapability(defaultVideoCapabilityDeps());
    const { prompt: videoPrompt } = await runVideoLane({
      workspace: runPaths.workspace,
      recordPath: runPaths.videoRecord,
      // The node id this phase already mints for its own graph_agent event —
      // find it with `grep -n 'graph_agent' dashboard/server/src/orchestrator.ts`.
      // If the build phase mints none, pass the run's root node; a graph_tool
      // naming an unknown node is DROPPED by foldGraph (api-types.ts:255-257),
      // which loses the pill rather than fabricating an agent.
      node: buildNode,
      env: process.env,
      capability,
      readManifest: () => {
        try {
          return JSON.parse(
            readFileSync(join(runPaths.workspace, "design-refs", "manifest.json"), "utf8"),
          ) as unknown;
        } catch {
          return null; // no DESIGN lane yet, or no manifest — zero legs, lane degrades
        }
      },
      spawnLeg: defaultSpawnLeg(capability.scriptPath ?? ""),
      // `BuildEventSink.graph` takes exactly `GraphSseEvent` (api-types.ts:430-438).
      emitGraph: (event) => sink.graph(event),
      writeRecord: (path, json) => writeFileSync(path, json, "utf8"),
    });
```

and append `videoPrompt` to the build agents' prompt where the DESIGN handoff text is assembled
(§7.3 mechanism 2: absolute paths in a prompt are what make a `Read`/`fetch` actually happen).
`videoPrompt` is `""` whenever there are no legs, so the append is unconditional and adds nothing
in the degraded case.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/kamilborzecki/Projects/coding-agent/dashboard/server && npx tsc -p tsconfig.json --outDir dist-video && node --test "dist-video/design/*.test.js" && npm test 2>&1 | tail -20`
Expected: PASS — twenty-one design tests, and the existing suite unchanged. Then `rm -rf dist-video`.

**Three mutations, executed and restored:**
1. Drop `TMPDIR` from `videoLaneEnv`. Expected: `expected undefined to match /^\/ws\//`.
2. Move the `emitGraph` call after `spawnLeg` returns and assert timing by making `spawnLeg` check
   `events.length`. Expected: the launch-time assertion fails — a completion-only event is the exact
   silence §7.6.3.4 names.
3. Add `GEMINI_API_KEY` to `STRIPPED_ENV_NAMES` in `subprocess-env.ts`. Expected:
   `deliberately NOT in STRIPPED_ENV_NAMES — spec §7.5: expected undefined to equal '…'`. **Restore
   immediately** — that file is a shared invariant.

- [ ] **Step 5: Commit**

```bash
git commit -F - -- dashboard/server/src/design/video-lane.ts dashboard/server/src/design/video-lane.test.ts dashboard/server/src/paths.ts dashboard/server/src/orchestrator.ts <<'MSG'
feat(video): the image->video lane, and the consumption pattern build agents need

Plans the legs, spends inside the cap, records the spend in seconds with
costUsd null, and injects spec §7.6.4's pattern -- fetch -> blob URL -> muted,
playsInline, paused video with a webp poster, currentTime driven by scroll in a
rAF loop -- with the real absolute paths in it, because a path in a prompt is
what makes the fetch actually happen (§7.3).

TMPDIR is moved inside the workspace: the script inherits gemini-image.sh's
`mktemp -d` in the SYSTEM temp dir, which spec §7.5 calls the most likely silent
breakage against allowWrite: [workspace]. GEMINI_API_KEY is deliberately NOT
stripped, and a test pins both directions.

graph_tool is emitted at LAUNCH, not completion: a leg takes minutes and an
event that arrives only at the end is the stalled-looking canvas §7.6.3.4 names.
The distinct long-running NODE STATE belongs to Phase 3 -- see the plan.
MSG
```

---

## Spec coverage

| Spec section | Where it is implemented |
|---|---|
| §7.6 — Veo 3.1, same key/provider/resolution order, no new credential | Task 1 (key resolution mirrors `gemini-image.sh:36-40`), Task 6 (the same order server-side) |
| §7.6 — 4 s at 720p corroboration | Task 8 (`DURATION_SECONDS = 4`, `RESOLUTION = "720p"`) |
| §7.6.1 — endpoint, header, body, poll URL, download path, verbatim | Task 1 (POST + body), Task 3 (poll + `.response.generateVideoResponse.generatedSamples[0].video.uri`), Task 4 (download) |
| §7.6.1 — models / aspect 16:9,9:16 only / duration 4,6,8 / 8 s for 1080p·4k / resolutions, Lite 1080p only | Task 2, every row with its own refusal test |
| §7.6.2 — sibling shape, flag grammar | Task 1 |
| §7.6.2(a) — key resolution order | Task 1, Task 6 |
| §7.6.2(b) — blocks until done, hard timeout | Task 3 |
| §7.6.2(c) — the `.webp` poster is a downscale of the still; converter preflight-asserted like `python3` | Task 2 (functional probe), Task 5 (the poster itself) |
| §7.6.3.1 — 16:9/9:16 pushed back into DESIGN; `animate` and `aspect` manifest fields | Task 7 (`planVideoLegs` rejects with a reason); the manifest shape is declared in File Structure and **Phase 2b writes it** |
| §7.6.3.2 — cap of 2, recorded opt-in to raise | Task 7, both enforcement points |
| §7.6.3.3 — audio generated and ignored, `muted` + `playsInline` | Task 8 (`videoConsumptionPrompt`, with an explicit "do not build on the audio track" line and a test for it) |
| §7.6.3.4 — the canvas needs a distinct long-running state | Task 8 **partially** — `graph_tool` at launch with a "takes minutes" caption. The distinct `GraphAgentState` member is NOT COVERED; see below |
| §7.6.4 — fetch→blob→muted/playsInline/paused, poster, rAF `currentTime = f(scrollProgress)`, absolute/object-fit:cover | Task 8 |
| §7.1a — the gate must not demand video until 2c lands; capability flag | Task 6, as a **guarded non-change** plus the flag itself. See CONCERN 2 |
| §7.5 — never echo the key | Task 4 (script failure path), Task 6 (capability object), Task 8 (prompt and canvas event) |
| §7.5 — `TMPDIR` inside the workspace | Task 8 |
| §7.5 — `costUsd` null, metered spend on its own line | Task 7 (`renderVideoSpend`), Task 8 (`results/video.json`) |
| §6.2 — no *unrecorded* input | Task 6 (script sha256), Task 8 (model, resolution, duration, cap, cap source, timeout all in the record) |

## NOT COVERED — stated rather than left silent

1. **A distinct long-running canvas node state.** §7.6.3.4 asks for one. `GraphAgentState` is
   `"running" | "completed" | "failed" | "stopped"` (`api-types.ts:189`) and adding a member touches
   **four hand-maintained sites plus a reducer plus the client**: `SseEvent`, `SSE_EVENT_TYPES`
   (`api-types.ts:407-424`, guarded by `_sseEventTypesComplete`), the client mirror
   `dashboard/src/lib/api-types.ts`, `EVENT_TYPES` in `dashboard/src/lib/use-run-stream.ts:90`, the
   `graph_agent_status` case in `graph.ts:172`, and `contract-parity.test.ts`. That is Phase 3's
   contract, not 2c's, and widening it while four agents edit the tree is how a canvas silently
   blanks. **What Phase 3 must add:** a `"long-running"` member of `GraphAgentState`, emitted by this
   lane at leg launch and cleared at leg end. **Until then a leg looks stalled for minutes**, and the
   only mitigation shipped here is the `graph_tool` caption saying so in words.
2. **Phase 2b's half of §7.6.3.1.** This plan *reads* `animate` and `aspect`; nothing here makes
   `taste-frontend-expert` generate an animate section at a Veo-compatible aspect. The DESIGN lane is
   Phase 2b and is not built. Until it is, `planVideoLegs` returns zero legs on every real manifest
   and the lane degrades — which is correct, but it means **no task here has been exercised against a
   manifest this project actually produced.**
3. **A per-request opt-in to raise the cap.** §7.6.3.2 says "per-run, recorded opt-in"; this plan
   implements it as `DASHBOARD_VIDEO_LEG_CAP`, read per run and recorded per run. A field on
   `POST /api/runs` would be a fifth declaration site in the frozen contract and belongs to whichever
   phase widens that route.
4. **No live Veo call is made by any task in this plan.** Every test runs against the loopback fake.
   The one live call this plan does specify is the settling experiment in CONCERN 1, and it is
   deliberately gated behind the owner's explicit go-ahead because it spends real money.
5. **`taste-frontend-expert.md` is not updated to document the new script.** Its body documents
   `gemini-image.sh` at `:37-45`; a sibling script that the agent is never told about will not be
   used by it. That edit belongs to Phase 2b, which is what wires the DESIGN lane; noted here so it
   is not lost.

## CONCERNS — spec facts implemented as written, with the doubt recorded

**CONCERN 1 — "8 s required for 1080p/4k **or reference images**", against a script whose only mode
is image→video.** §7.6.1's values table says duration is `4|6|8` with 8 s required for 1080p/4k **or
reference images**. Every call this script makes carries `instances[].image`. Read literally, that
makes `-d 8` mandatory for *every* leg — which contradicts §7.6's own corroboration in the same
section, that the reference site's **4.04 s at 1280×720 is exactly `durationSeconds: "4"` at
`resolution: "720p"`**. The likely reading is that Veo distinguishes the first-frame `image` from a
separate reference/style-asset parameter and that the 8 s rule attaches to the latter — but that is a
guess and this plan does not act on a guess. **Written to the spec:** default `-d 4`, and only the
documented `1080p`/`4k` combinations are refused. **How it gets settled, cheaply:** before Phase 2b
wires the lane into a real run, make **one** deliberate live call — `-d 4 -r 720p -a 16:9` on a real
still — record the exit code and, if it is a 400, the redacted `error.status`/`error.message`. If it
400s, change one default and one validation line. **Do not reason about this; measure it.** It spends
one leg.

**CONCERN 2 — §7.1a's capability-flag mechanism would be a regression against shipped, measured
code, so this plan does not implement it.** §7.1a says to *"gate the satisfier list on a capability
flag derived from whether `gemini-video.sh` is present and a key resolves."* Phase 2a shipped the
staging by a different mechanism: `decideMotion` (`antislop-rules.ts:673-729`) already lists
scroll-scrubbed video **first and unconditionally**, and its header comment states the reasoning —
*"VIDEO IS ONE SATISFIER AMONG THREE AND NEVER A REQUIREMENT… The disjunction is what makes the
staging automatic — no capability flag needed."* A disjunction cannot demand any one of its terms, so
§7.1a's actual **requirement** ("until 2c lands, the gate must not demand video") is already met. A
flag that gates a satisfier list can only ever **remove** satisfiers, and with `available: false` it
would fail a build that hand-authored a scroll-scrubbed mp4 with no Veo involved — which is precisely
what **kamilborzecki.dev, the owner's own reference, ships today**. That inverts degrade-don't-block
and re-opens a ruleset with measured false-positive/true-positive numbers behind it (2a §10.1, §10.5).
So Task 6 ships the flag for the jobs it is genuinely needed for — DESIGN-lane routing, the run
record, prompt injection — and `motion-staging.test.ts` **guards the non-change**, going red if a
later author wires the flag into `decideMotion`.

**CONCERN 3 — `sips` is offered by §7.6.2 as the built-in macOS converter and, on this host, cannot
produce webp at all.** Measured, not inferred: `sips -s format webp in.png --out out.webp` exits
**13 and writes no file** (sips-316, Darwin 25.6). `cwebp` 1.6.0 is present at
`/opt/homebrew/bin/cwebp` and produces `RIFF….WEBPVP8X`. The plan keeps both candidates in the spec's
order of mention but **probes them functionally** and selects by output magic bytes, so a host where
`sips` *does* work still works and this one selects `cwebp`. The consequence to state plainly:
**`cwebp` is a real dependency on this machine**, installed via Homebrew and not built in. If it is
missing, the lane refuses before spending — which is the right failure, but it is a failure.

**CONCERN 4 — the key is in `curl`'s argv, and no test in this plan covers that.** §7.6.1 fixes the
download command verbatim as `curl -L -o leg-N.mp4 -H "x-goog-api-key: $KEY" "<uri>"`, so the key
appears in the child process's command line and is readable by any process running as the same user
(`ps -ww`). This is **not a regression** — `gemini-image.sh:67-71` does the same — and the plan does
not deviate from a verbatim spec command to fix it. The key-leak test in Task 4 covers **stdout and
stderr only**, and says so. The mitigation, if the owner wants it: a `curl -K <config-file>` written
into the 600-perm private tmpdir, carrying `header = "x-goog-api-key: …"`, which changes no flag the
spec names and removes the key from argv entirely. **Not done here, because it edits a command the
spec states verbatim.**

**CONCERN 5 — the poll interval and the hard timeout are not spec values.** §7.6.2 requires "a hard
timeout" and gives no number. `GEMINI_VIDEO_POLL_SEC=10` (mirroring `gemini-image.sh:81`'s 10 s
backoff) and `GEMINI_VIDEO_TIMEOUT_SEC=900` are **chosen**, on §7.6.3.4's "a video leg takes minutes,
not seconds". Both are env-overridable and the resolved timeout is written into `results/video.json`,
so a run that hit the deadline is explainable rather than mysterious.

## Definition of done

- [ ] `node --test dashboard/server/gemini-video-harness.mjs` — thirteen tests green, against the fake endpoint only.
- [ ] The sentinel test proves `GEMINI_VIDEO_API_BASE` took effect; nothing else is trusted without it.
- [ ] `npx tsc -p tsconfig.json --outDir dist-video && node --test "dist-video/design/*.test.js"` — twenty-one tests green. `rm -rf dist-video`; it is never committed.
- [ ] `npm test` in `dashboard/server` is no worse than it was before this phase (`calibration.test.js` needs Docker and fixtures this plan does not own; if it is excluded, say so rather than rounding up to a pass).
- [ ] **Every mutation listed in Tasks 3, 4, 5, 6, 7 and 8 has been executed, observed red, and restored.** A check never seen failing is decoration; this project has ten recorded instances.
- [ ] The cap is proven by counting invocations, at both enforcement points, each failing on its own.
- [ ] A truncated download leaves neither `leg-1.mp4` nor `leg-1.mp4.part`.
- [ ] The sentinel key appears in no test's captured stdout or stderr, in no capability object, in no prompt fragment, in no graph event, and in no commit.
- [ ] `results/video.json` carries `costUsd: null`, metered **seconds**, the cap and its source, and the script's sha256.
- [ ] `~/.claude/scripts/gemini-video.sh` is executable and **is not in the repository**.
- [ ] `verdict.ts`, `run-report.ts`, `spec-assumptions.ts`, `calibration.test.ts`, `calibration/fixtures.ts`, `bakeoff/**`, `dashboard/STATUS.md`, `bakeoff/STATUS.md` untouched. `orchestrator.ts` touched at exactly one call site. No attribution trailer. No `--amend`. No `push`.

## Explicitly NOT in Phase 2c

- **The DESIGN lane itself.** Phase 2b generates the stills and writes `animate`/`aspect`. 2c reads them.
- **Any change to `decideMotion` or the anti-slop rulesets.** See CONCERN 2.
- **The canvas.** Phase 3 owns `GraphAgentState` and the long-running node.
- **Cron.** Phase 4, and deliberately after a trustworthy gate.
