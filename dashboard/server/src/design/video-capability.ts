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
 *
 * WHAT §7.1a'S FLAG IS FOR, AND WHAT IT IS NOT FOR. It routes the DESIGN lane,
 * it is recorded per run, and it decides what the prompts ASK FOR. It does NOT
 * reach `decideMotion` (`../builders/antislop-rules.ts:673`), whose satisfier
 * list is a disjunction that already carries scroll-scrubbed video first and
 * unconditionally. A flag over a disjunction can only ever REMOVE satisfiers,
 * so wiring it in would fail a hand-authored scroll-scrubbed mp4 — the very
 * technique the owner's reference site ships. `motion-staging.test.ts` guards
 * that non-change; see CONCERN 2 in the Phase 2c plan.
 *
 * WHY THIS IS NOT `detectDesignCapability` (`../design-capability.ts:88`).
 * That function already answers the same yes/no for the DESIGN lane's prompts
 * and it stays where it is. It resolves the key through the REAL `existsSync` /
 * `readFileSync`, and its own header records that on this host it is the
 * `~/.gemini/api_key` branch that wins — so a suite built on it would be
 * host-dependent, and it carries no digest. §6.2 wants the digest: the script
 * lives outside the repository, so git records nothing about which version of
 * it a run used. Hence an injected reader here, and one extra field.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GeminiKeySource } from "../design-capability.js";

/**
 * Deliberately an alias, not a second literal union. The two modules resolve the
 * same three sources in the same order, and a copy would let them drift silently
 * — a renamed source in one file and a stale string in the other still typecheck.
 */
export type VideoKeySource = GeminiKeySource;

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
  if (onDisk !== null && onDisk.replace(/\s/gu, "") !== "") return "~/.gemini/api_key";
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
