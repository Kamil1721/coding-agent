/**
 * video-capability.test.ts — the resolution order, the three degradations, the
 * hash, and the one assertion that matters most: the key's VALUE is not in the
 * object, because this object is serialised into a run record.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defaultVideoCapabilityDeps, videoCapability, type VideoCapabilityDeps } from "./video-capability.js";

const SCRIPT = "/home/u/.claude/scripts/gemini-video.sh";
const KEY = "AIza-SENTINEL-NEVER-PRINT-1234567890";

/**
 * The exact bytes of the default fixture script below, and the sha256 of those
 * bytes COMPUTED OUTSIDE NODE:
 *
 *   printf '#!/usr/bin/env bash\necho hi\n' | shasum -a 256
 *   ea3bf4b4b4b312e437b5e01a3056d9dcc8d7a4d98669f265f6e73d4548618720
 *
 * Hard-coded rather than recomputed with `createHash` in the test, which would
 * be circular: the same wrong input hashed twice agrees with itself. This one
 * literal is what catches hashing the PATH instead of the contents, or hashing
 * with a different encoding — neither of which the "a changed script changes the
 * hash" assertion below can see.
 */
const FIXTURE_SCRIPT = "#!/usr/bin/env bash\necho hi\n";
const FIXTURE_SHA256 = "ea3bf4b4b4b312e437b5e01a3056d9dcc8d7a4d98669f265f6e73d4548618720";

function deps(over: Partial<{ env: NodeJS.ProcessEnv; files: Record<string, string> }> = {}): VideoCapabilityDeps {
  const files = over.files ?? { [SCRIPT]: FIXTURE_SCRIPT };
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
    videoCapability(deps({ files: { [SCRIPT]: "#!/bin/sh\n", "/home/u/.gemini/api_key": `  ${KEY}\n` } })).keySource,
    "~/.gemini/api_key",
    "trimmed, mirroring `tr -d '[:space:]'`",
  );
});

test("a whitespace-only key file is not a key — `tr -d '[:space:]'` yields the empty string", () => {
  // design-capability.ts:44-46 records the same fact for the image script: the
  // script dies at :40 on a blank key, so reporting "available" sends the lane
  // at a call that cannot succeed.
  const c = videoCapability(deps({ files: { [SCRIPT]: FIXTURE_SCRIPT, "/home/u/.gemini/api_key": " \n\t\n" } }));
  assert.equal(c.keySource, null);
  assert.equal(c.available, false);
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
  assert.equal(
    c.scriptSha256,
    FIXTURE_SHA256,
    "the digest of the script's CONTENTS, checked against a value computed by shasum, not by this process",
  );
  const changed = videoCapability(
    deps({ env: { GEMINI_API_KEY: KEY }, files: { [SCRIPT]: "#!/usr/bin/env bash\necho CHANGED\n" } }),
  );
  assert.notEqual(changed.scriptSha256, c.scriptSha256, "a changed script is a changed input (§6.2)");
});

test("the default deps read the real filesystem and answer null for a file that is not there", () => {
  // The injected `readFile` is what makes every test above hermetic, so the REAL
  // one is otherwise never executed by this suite: a `defaultVideoCapabilityDeps`
  // whose reader threw on ENOENT would take the whole lane down at the first
  // capability check and no test here would have seen it.
  //
  // NOTHING IS ASSERTED ABOUT THE RESOLVED KEY. On this host the third branch is
  // the one that resolves (design-capability.ts:48-51), and an assertion about a
  // real key is both host-dependent and a step towards printing one.
  const real = defaultVideoCapabilityDeps();
  assert.equal(real.home, process.env["HOME"] ?? "");
  assert.equal(real.readFile("/nonexistent/gemini-video.sh"), null);
  assert.equal(real.env, process.env);
});
