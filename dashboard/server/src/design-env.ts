/**
 * design-env.ts — the two environment decisions a DESIGN run needs.
 *
 * TMPDIR IS THE MOST LIKELY SILENT BREAKAGE IN THE WHOLE IMAGE CHAIN (spec §7.5,
 * its own words). `gemini-image.sh:43` does `mktemp -d` in the SYSTEM temp dir
 * and writes the request body and the API response there;
 * `sandbox.filesystem.allowWrite` is `[workspace]` (claude-builder.ts). If the
 * sandbox refuses that write the script dies before it ever reaches the API, and
 * because `autoAllowBashIfSandboxed: true` means Bash never reaches
 * `decideToolPermission`, nothing on the host sees a permission event. The lane
 * simply produces nothing.
 *
 * AND SETTING TMPDIR DOES NOT FIX IT ON MACOS — MEASURED 2026-07-29, NOT ASSUMED.
 * `mktemp(1)` on darwin: "if no arguments are passed or if only the -d flag is
 * passed mktemp behaves as if -t tmp was supplied", and `-t` builds its template
 * from `_CS_DARWIN_USER_TEMP_DIR`, falling back to TMPDIR only "if
 * _CS_DARWIN_USER_TEMP_DIR is not available" — which, on a Mac, it always is. So
 * `gemini-image.sh:43`'s BARE `mktemp -d` lands in `/var/folders/…/T` whatever
 * this file sets, and a seatbelt profile shaped like the CLI's own denies it:
 * `mkdtemp failed on /var/folders/…/T/tmp.Vh251dl8Ei: Operation not permitted`.
 * `design-env.test.ts` reproduces all three arms of that.
 *
 * WHAT THIS VARIABLE IS THEREFORE FOR, STATED HONESTLY. It is the value any
 * TMPDIR-honouring tool uses (GNU `mktemp`'s default template is
 * `$TMPDIR/tmp.XXXXXXXXXX`), it is the value the explicit-template form resolves
 * against, and it is what an unsandboxed run — `DASHBOARD_ALLOW_UNSANDBOXED_BUILDER`
 * — actually reads. It is NOT sufficient for the bare form on darwin, and the fix
 * that would be is one line in `~/.claude/scripts/gemini-image.sh` —
 * `mktemp -d "${TMPDIR:-/tmp}/gemini-image.XXXXXXXX"` — which is the owner's file,
 * outside this repo, and needs the owner's approval rather than a silent edit.
 *
 * THE MOTION-BAR FLIP IS OURS BY EXPLICIT HANDOVER. claude-builder.ts registers
 * the Layer-2 Stop hooks only when `DASHBOARD_MOTION_BAR=1` and says so in
 * prose: "the ORCHESTRATOR turns it on for the runs the lane routing says are
 * visual. Phase 2b owns that flip." Phase 2a measured that always-on would block
 * a legitimate build of this repo's own client, so the flag is set here, per run,
 * from the lane mode — and an inherited value is REMOVED rather than respected,
 * because an operator's shell must not arm a completion gate on a CLI ticket.
 *
 * TWO CALLERS ARE REQUIRED, AND ONE WITHOUT THE OTHER PRODUCES ZERO PNGs
 * SILENTLY. This function only NAMES the directory; something has to CREATE it,
 * because `mktemp -d` against a TMPDIR that does not exist fails exactly as
 * loudly as a sandbox denial — which is to say, not at all, on a stream the
 * permission layer cannot see. The orchestrator therefore needs BOTH
 * `env: designSubprocessEnv(...)` on its `builder.build(...)` call AND
 * `mkdirSync(designTmpDirFor(workspace), { recursive: true })` in
 * `#prepareWorkspace`. Wiring is Task 10's; see this file's return-value note.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: create that directory itself. Five of
 * its tests pass a workspace that does not exist on this machine, so a mkdir here
 * would either litter the filesystem or throw-and-swallow — and a swallowed mkdir
 * is a function claiming a directory exists when it may not, which is the exact
 * defect shape this phase is built to avoid.
 *
 * THE KEY NAMES SURVIVE ON PURPOSE. `GEMINI_API_KEY` and `NANOBANANA_API_KEY` are
 * absent from `STRIPPED_ENV_NAMES` (`subprocess-env.ts:39-55`, verified by
 * reading it) so the lane can spend at all, and `design-env.test.ts` is the guard
 * that keeps them absent. That absence is also why "never echo the key" is a
 * constraint rather than a nicety: the value really is in the subprocess
 * environment, so nothing here — or anywhere downstream — may ever print one.
 */

import { join } from "node:path";
import { MOTION_BAR_ENV } from "./builders/claude-builder.js";
import { subscriptionSubprocessEnv } from "./subprocess-env.js";

/** Inside the workspace, and dot-prefixed so it reads as harness state. */
export const DESIGN_TMP_DIR = ".design-tmp";

export function designTmpDirFor(workspace: string): string {
  return join(workspace, DESIGN_TMP_DIR);
}

/**
 * The environment for a build that may run the DESIGN lane.
 *
 * A SUBTRACTION PLUS TWO DECISIONS, in that order: `subscriptionSubprocessEnv`
 * first, so the metered credentials go and `costUsd: null` stays true, then
 * TMPDIR and the motion bar. The Gemini key names are NOT in
 * `STRIPPED_ENV_NAMES` and must not be added there — that absence is what lets
 * the lane spend at all, and `design-env.test.ts` is the guard on it.
 */
export function designSubprocessEnv(
  base: NodeJS.ProcessEnv,
  opts: { workspace: string; motionBar: boolean },
): NodeJS.ProcessEnv {
  const env = subscriptionSubprocessEnv(base);
  env["TMPDIR"] = designTmpDirFor(opts.workspace);
  if (opts.motionBar) env[MOTION_BAR_ENV] = "1";
  else delete env[MOTION_BAR_ENV];
  return env;
}
