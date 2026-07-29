/**
 * design-capability.ts — can this machine actually make a mockup, and if not, WHY.
 *
 * SPEC §7.5 IS A TABLE OF WAYS THE IMAGE CHAIN BREAKS AND ONE REASON NONE OF
 * THEM IS VISIBLE: `sandbox.autoAllowBashIfSandboxed: true` means Bash never
 * reaches `decideToolPermission`, so every one of them surfaces as a script error
 * on a stream the permission layer cannot see. A lane with a missing `python3`
 * and a lane with no ticket work to do are the same observable — zero PNGs.
 *
 * So the answer is decided HERE, BEFORE the lane runs, and written down. A zero-
 * image lane can then always be told apart from a lane that was never going to
 * produce images (design-outcome.ts is what tells them apart).
 *
 * THE KEY VALUE NEVER LEAVES THIS FILE. `GeminiKeyResolution` carries WHICH
 * source won and nothing else. CLAUDE.md:18 and §7.5's key-survives-stripping
 * row: the two Gemini variables are deliberately absent from
 * `STRIPPED_ENV_NAMES` (`subprocess-env.ts:39-55`) so they survive into the
 * subprocess — which is intended, and which is exactly why nothing here may ever
 * print one.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GEMINI_IMAGE_SCRIPT = "~/.claude/scripts/gemini-image.sh";
export const GEMINI_VIDEO_SCRIPT = "~/.claude/scripts/gemini-video.sh";

export type GeminiKeySource = "GEMINI_API_KEY" | "NANOBANANA_API_KEY" | "~/.gemini/api_key";

export interface GeminiKeyResolution {
  readonly available: boolean;
  /** WHICH source resolved. Never the value; see the file header. */
  readonly source: GeminiKeySource | null;
}

/**
 * `gemini-image.sh:36-39`, mirrored:
 *
 *   KEY="${GEMINI_API_KEY:-${NANOBANANA_API_KEY:-}}"
 *   if [ -z "$KEY" ] && [ -f "$HOME/.gemini/api_key" ]; then
 *     KEY="$(tr -d '[:space:]' < "$HOME/.gemini/api_key")"
 *
 * The `tr -d '[:space:]'` matters: a whitespace-only key file yields the empty
 * string and the script dies at :40. Reporting "available" for it would send the
 * lane at a script that cannot succeed.
 *
 * THE THIRD BRANCH IS THE NORMAL ONE ON THIS MACHINE, not an edge case — neither
 * environment variable is set here, so the file is what resolves. A check that
 * only handled the env vars would report "no key" on the machine the lane is
 * meant to run on.
 */
export function geminiKeyAvailable(env: NodeJS.ProcessEnv, homeDir: string): GeminiKeyResolution {
  const fromEnv = (env["GEMINI_API_KEY"] ?? "").length > 0 ? "GEMINI_API_KEY" : null;
  if (fromEnv !== null) return { available: true, source: fromEnv };
  if ((env["NANOBANANA_API_KEY"] ?? "").length > 0) return { available: true, source: "NANOBANANA_API_KEY" };
  const keyFile = join(homeDir, ".gemini", "api_key");
  if (!existsSync(keyFile)) return { available: false, source: null };
  let contents = "";
  try {
    contents = readFileSync(keyFile, "utf8");
  } catch {
    return { available: false, source: null };
  }
  // The length is all that is taken from the contents. The string itself is not
  // returned, logged, or put in a detail line anywhere below.
  const stripped = contents.replace(/\s+/gu, "");
  return stripped.length > 0 ? { available: true, source: "~/.gemini/api_key" } : { available: false, source: null };
}

export interface DesignCapability {
  /** Absolute path to a script that exists, or null. */
  readonly imageScript: string | null;
  readonly key: GeminiKeyResolution;
  /**
   * §7.1a: "a capability flag derived from whether `gemini-video.sh` is present
   * and a key resolves". FALSE through 2b — the script does not exist yet. It
   * gates what the prompts ASK FOR and what the Layer-2 reason text OFFERS; it
   * never removes an accepted satisfier. See design-prompt.ts.
   */
  readonly video: boolean;
}

function expandHome(path: string, homeDir: string): string {
  return path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
}

export function detectDesignCapability(opts: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  imageScript?: string;
  videoScript?: string;
}): DesignCapability {
  const key = geminiKeyAvailable(opts.env, opts.homeDir);
  const image = expandHome(opts.imageScript ?? GEMINI_IMAGE_SCRIPT, opts.homeDir);
  const video = expandHome(opts.videoScript ?? GEMINI_VIDEO_SCRIPT, opts.homeDir);
  return {
    imageScript: existsSync(image) ? image : null,
    key,
    video: existsSync(video) && key.available,
  };
}

/**
 * Override for the image script's location.
 *
 * EXISTS FOR THE NEGATIVE CONTROL, AND THAT IS A GOOD ENOUGH REASON. THE TRAP's
 * proof is a run whose image script is deliberately broken, and the script is
 * reached by an ABSOLUTE path — `designSegmentPrompt` puts
 * `capability.imageScript` into the agent's instructions verbatim — so no `PATH`
 * shim can intercept it. Without this the one control that matters could not be
 * executed without vandalising the owner's `~/.claude/scripts/`.
 *
 * A BLANK VALUE IS NOT AN OVERRIDE. An empty or whitespace-only variable is what
 * an unset shell export looks like, and honouring it would resolve the script to
 * `""` — `existsSync("")` is false, so the lane would silently degrade on a
 * machine where the real script is present.
 */
export const DESIGN_SCRIPT_ENV = "DASHBOARD_GEMINI_IMAGE_SCRIPT";

export function designScriptPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = (env[DESIGN_SCRIPT_ENV] ?? "").trim();
  return override.length > 0 ? override : expandHome(GEMINI_IMAGE_SCRIPT, homeDir);
}

export interface PreflightCheck {
  readonly id: "python3" | "npx-impeccable" | "image-script" | "gemini-key" | "tmpdir";
  readonly ok: boolean;
  readonly blocking: boolean;
  readonly detail: string;
}

export interface DesignPreflight {
  readonly checks: readonly PreflightCheck[];
  readonly ok: boolean;
  readonly blockers: readonly string[];
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; stderr: string }>;

/**
 * The real runner. INJECTED rather than called directly from `designPreflight`
 * so the checks are unit-testable without spawning `npx` — a preflight whose
 * tests need a network is a preflight nobody runs.
 *
 * THE `error` HANDLER IS THE WHOLE POINT, not defensive padding. `spawn` of a
 * binary that is not on PATH emits `error` (ENOENT) and NEVER emits `close`, so
 * without it the missing-`python3` case — the one §7.5 names — would hang until
 * the kill timer rather than report a non-zero code. It is executed by a test.
 *
 * Bounded: a hanging `npx` must not hang a build before it starts.
 */
export const execCommandRunner: CommandRunner = async (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 2048);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: `${command} could not be spawned` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });

/** Can this directory be created and written? Creates it, because the answer is needed either way. */
export function canWriteDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, ".write-probe");
    writeFileSync(probe, "", "utf8");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * §7.5's rows, executed.
 *
 * BLOCKING: `python3`, the script, the key. Without any one of them not a single
 * PNG can exist, so running the lane would burn turns to reach a certainty.
 *
 * NON-BLOCKING BUT RECORDED: `npx impeccable` and `TMPDIR`. §7.5 says "assert
 * resolvable"; it does not say "block", and refusing a design run because a
 * registry fetch is unavailable would invent a failure mode the spec does not
 * ask for. `impeccable` degrades one preloaded skill. `TMPDIR` is SET by
 * design-env.ts; this check only reports whether the directory is usable.
 *
 * WHICH ROWS BLOCK IS PINNED BY A TEST, not by this comment: the `blockers`
 * array is asserted verbatim in the all-five-fail case, so flipping any one of
 * these `blocking` flags turns an assertion red.
 */
export async function designPreflight(opts: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  workspace: string;
  capability: DesignCapability;
  run: CommandRunner;
  canWrite: (dir: string) => boolean;
}): Promise<DesignPreflight> {
  const checks: PreflightCheck[] = [];

  const python = await opts.run("python3", ["--version"]);
  checks.push({
    id: "python3",
    ok: python.code === 0,
    blocking: true,
    detail:
      python.code === 0
        ? "python3 is on PATH"
        : `python3 is not runnable (exit ${String(python.code)}). gemini-image.sh uses it at :48 to ` +
          `build the request body and at :97 to decode the image; without it every generation fails ` +
          `with no PNG and no error the host can see.`,
  });

  const impeccable = await opts.run("npx", ["--no-install", "impeccable", "--version"]);
  checks.push({
    id: "npx-impeccable",
    ok: impeccable.code === 0,
    blocking: false,
    detail:
      impeccable.code === 0
        ? "npx impeccable resolves locally"
        : "npx impeccable does not resolve offline. The impeccable skill's allowed-tools permits " +
          "Bash(npx impeccable *) and its base-dir resolution does NOT cover that pattern, so its setup " +
          "step will attempt a registry fetch at run time and may fail. The lane still runs.",
  });

  checks.push({
    id: "image-script",
    ok: opts.capability.imageScript !== null,
    blocking: true,
    detail:
      opts.capability.imageScript === null
        ? `no image script at ${GEMINI_IMAGE_SCRIPT}. taste-frontend-expert shells out to that exact ` +
          `absolute path, so nothing on PATH substitutes for it.`
        : `image script at ${opts.capability.imageScript}`,
  });

  checks.push({
    id: "gemini-key",
    ok: opts.capability.key.available,
    blocking: true,
    // The SOURCE NAME, never the value. `GeminiKeyResolution` does not carry the
    // value, so this line cannot leak one even by mistake.
    detail: opts.capability.key.available
      ? `a key resolves from ${String(opts.capability.key.source)}`
      : "no key resolves from GEMINI_API_KEY, NANOBANANA_API_KEY or ~/.gemini/api_key. The DESIGN " +
        "lane degrades to written art direction with no PNGs; it does not block (spec §6.5).",
  });

  const tmp = join(opts.workspace, ".design-tmp");
  const writable = opts.canWrite(tmp);
  checks.push({
    id: "tmpdir",
    ok: writable,
    blocking: false,
    detail: writable
      ? `TMPDIR will be ${tmp}, inside sandbox.filesystem.allowWrite`
      : `${tmp} is not writable. gemini-image.sh:43 does mktemp -d in the SYSTEM temp dir while ` +
        `allowWrite is [workspace] — the most likely silent breakage in the chain (spec §7.5).`,
  });

  const blockers = checks.filter((c) => c.blocking && !c.ok).map((c) => c.id);
  return { checks, ok: blockers.length === 0, blockers };
}
