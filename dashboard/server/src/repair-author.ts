/**
 * repair-author.ts — the component that WRITES a candidate patch, and does
 * nothing else with it.
 *
 * ─── WHY THIS FILE EXISTS ───
 *
 * MEASURED 2026-08-12, from `tools/repair/supervisor-cycle.mjs#decideRepairOutcome`:
 * with no diff at `<proposalsDir>/<signature>.diff` the whole self-repair chain
 * answers `NO_PATCH_AUTHOR` and stops. Every other link is built — anti-loop
 * guard, ruled-out ledger, evidence bar on an isolated copy of HEAD, Tier 3
 * gate, apply-on-token, rollback record — and the only human left in the loop is
 * the one who types the diff. This file is that human's seat, and nothing more.
 *
 * ─── THE RULE IT OBEYS, QUOTED FROM THE THING IT FEEDS ───
 *
 * `tools/repair/cycle.mjs`: "The patch AUTHOR is not in this file and
 * deliberately not in this lane. A candidate diff arrives as an input;
 * everything here is the bar it has to clear. That split is the point: the
 * evidence bar is the product, and a component that both writes the patch and
 * grades it is the shape this repository keeps catching itself in."
 *
 * SO THIS FILE MAY NOT GRADE, PROVE, APPLY OR GATE ANYTHING. It emits a diff to
 * a path and returns. It imports nothing from `tools/repair` or `tools/tier3`,
 * it never spawns the cycle or the gate, it never writes the ruled-out ledger
 * (that ledger is the grader's record, and an author writing rows in it is the
 * same collapse by another route), and it never touches the repository tree
 * outside `proposalsDir` and its own journal. The one function in the tree that
 * writes a patch into the working tree is still `supervisor-gate.mjs#applyGatedPatch`,
 * and it still refuses anything but an APPLY token.
 *
 * ─── WHY IT LIVES IN dashboard/server/src AND NOT IN tools/repair ───
 *
 * 1. THE CYCLE IS A SUBPROCESS WITH NO MODEL. `createRepairDriver`
 *    (`supervisor-boot.ts:279`) spawns `supervisor-cycle.mjs` through
 *    `createCycleRunner` — a plain `node` child with argv and a wall clock. It
 *    has no TypeScript build, no Agent SDK, no seat, and no `SpendCeiling`. An
 *    author living in `tools/repair/` would need a second way to call a model,
 *    which is exactly what the brief forbids.
 * 2. THE SEAT MACHINERY IS HERE AND IS NOT PORTABLE. `SubscriptionSeatCaller`
 *    (`subscription-caller.ts:1769`) is the only thing on this machine that
 *    calls a model on the owner's subscription, and it is a TypeScript class
 *    compiled into `dashboard/server/dist`. Reaching into `dist` from an `.mjs`
 *    would make `tools/repair` depend on the server's build output.
 * 3. AND IT KEEPS THE LANES APART. The author is upstream of the driver; the bar
 *    and the gate are downstream of it. Putting the author in `tools/repair/`
 *    would put the writer and the grader in one directory, which is the shape
 *    `cycle.mjs`'s header names.
 *
 * The wiring is therefore {@link createAuthoringRepairDriver}, composed around
 * `createRepairDriver`'s return value in `index.ts`. `supervisor-boot.ts` is
 * NOT modified: the wrapper is driver-shaped in and driver-shaped out, so the
 * boot file's arm check still measures the same driver it always did.
 *
 * ─── WHAT THE MODEL CAN SEE, AND WHY THAT IS THE WHOLE SAFETY ARGUMENT ───
 *
 * `SubscriptionSeatCaller` pins `tools: []` and `settingSources: []` on the CLI
 * subprocess (`subscription-caller.ts:1956`), so the seat cannot read a file,
 * run a command, or see the acceptance suite. Everything it knows arrives in the
 * prompt, and this file builds the prompt. That is why the two-phase shape
 * below is not ceremony: phase 1 asks which files it wants, this file VALIDATES
 * those names against the filesystem and the refused set, and phase 2 sends only
 * what survived. A path that never passes {@link refusedPathReason} is never
 * read, never sent, and never patchable.
 *
 * FILE CONTENTS COME FROM HEAD, NOT FROM THE WORKING TREE, and that single
 * choice decides whether the output can ever clear the bar. `isolate.mjs` builds
 * the bar's copy with `git archive HEAD`, so a diff whose context lines were
 * copied from a dirty working tree cannot apply there. MEASURED 2026-08-12:
 * `git status` listed 11 modified files at the time this was written, six of
 * them source. So targets are read with `git show HEAD:<path>` and the resolved
 * sha is recorded on the journal row.
 *
 * THE SHA IS NOT EMBEDDED IN THE DIFF BYTES, deliberately. It could be: MEASURED
 * 2026-08-12 in a scratch repository, `git apply -p1` applies a patch carrying a
 * leading `# …` comment line (exit 0, file changed), and `diff.mjs#parseUnifiedDiff`
 * ignores any line that is not a `---`/`+++` pair or a hunk header. But
 * `evidence.mjs#proposalFingerprint` hashes through `normaliseDiff`, which strips
 * only `index ` and `diff --git ` lines — so a sha in the bytes would give the
 * SAME patch a NEW fingerprint every time HEAD moved, and `ALREADY_RULED_OUT`
 * would stop firing. Ledger dedup is worth more than a comment nothing parses.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SPEC_SEAT } from "bakeoff/dist/config.js";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { truncate } from "./claude-common.js";
import { DASHBOARD_BUDGET, DEFAULT_SPEC_MODEL, SPEC_MODEL_ENV } from "./orchestrator.js";
import { newAuthoringCeiling, SubscriptionSeatCaller } from "./subscription-caller.js";
import type { SupervisorRepairOutcome, SupervisorRepairRequest } from "./supervisor.js";

/** Where the authoring journal goes, relative to `dashboard/data`. */
export const DEFAULT_AUTHOR_JOURNAL_DIRNAME = "repair-authoring";

/**
 * The seat this author runs on.
 *
 * ROLE IS `subagent` BECAUSE THE UNION HAS NO ROOM FOR ANOTHER ONE.
 * `SeatRole` is `"orchestrator" | "subagent" | "spec" | "judge"`
 * (`bakeoff/src/contracts.ts:120`) and `contracts.ts` is frozen this round, so a
 * `repair` role would be an edit to a file this lane may not touch. `subagent`
 * is the rung that means "does bounded work for something else"; `spec` and
 * `judge` are held-constant bake-off controls whose spend rows are read as
 * measurements of those phases, and borrowing one would put authoring tokens in
 * a column that means something else.
 *
 * EVERYTHING ELSE IS SPREAD FROM `SPEC_SEAT` so the effort rung and the
 * credential name have ONE source of truth (`bakeoff/src/config.ts`).
 */
export const PATCH_AUTHOR_SEAT: AnthropicSeat = Object.freeze({
  ...SPEC_SEAT,
  role: "subagent",
  notes:
    "The self-repair patch author. Proposes ONE candidate diff for a defect record and never grades, " +
    "proves, applies or gates it — see dashboard/server/src/repair-author.ts. Runs on the same " +
    "subscription seat machinery and the same SpendCeiling as every other seat; tools: [] means it " +
    "reads no file and runs no command, so its whole view is the prompt this repository builds.",
});

/**
 * The seat with the model id this machine actually runs, which is NOT the one
 * the frozen literal carries.
 *
 * MEASURED 2026-08-12 in `orchestrator.ts`: every production seat is built as
 * `#seat(runId, SPEC_SEAT)`, and `#seat` OVERRIDES `modelId` with
 * `#usableSpecModel` → `env[DASHBOARD_SPEC_MODEL] ?? DEFAULT_SPEC_MODEL`, which
 * is `"claude-opus-5[1m]"`. `SPEC_SEAT.modelId` is `"claude-opus-5"` and reaches
 * no CLI anywhere in this program. An author that used the literal would be the
 * only seat in the process running an id nothing else runs — and whether the CLI
 * accepts it is UNMEASURED, so the failure would arrive as `AUTHOR_CALL_FAILED`
 * on every ticket, at night, looking like a model problem.
 *
 * THE OUTPUT-CEILING REFUSAL IS NOT COPIED, AND THAT IS A GAP, NAMED.
 * `#usableSpecModel` also refuses a model whose measured ceiling is below the
 * 128,000 tokens the spec seat's first call asks for. This seat asks for
 * {@link AUTHOR_MAX_OUTPUT_TOKENS} (32,000), so the same table would refuse a
 * different, smaller set of models — and a truncated authoring turn already
 * arrives as `stopReason: "max_tokens"`, which {@link authorRepairPatch} names in
 * its refusal. Wiring `outputCeilingFor` here is carried forward, not done.
 */
export function patchAuthorSeat(env: NodeJS.ProcessEnv): AnthropicSeat {
  const pinned = (env[SPEC_MODEL_ENV] ?? "").trim();
  return { ...PATCH_AUTHOR_SEAT, modelId: pinned === "" ? DEFAULT_SPEC_MODEL : pinned };
}

/**
 * Output ceiling for the authoring call.
 *
 * 32,000 is the same rung `judge.ts` uses for its one-shot call, and it is the
 * FIRST bound on diff size — {@link MAX_DIFF_BYTES} is the second, applied to
 * what comes back. Two bounds because they fail differently: the ceiling
 * produces a truncated answer (`stopReason: "max_tokens"`, named separately),
 * the byte cap produces a refusal.
 */
export const AUTHOR_MAX_OUTPUT_TOKENS = 32_000;

/** Survey answers are a short JSON object; this rung is generous for one. */
export const SURVEY_MAX_OUTPUT_TOKENS = 4_000;

/**
 * THE AUTHOR'S OWN WALL CLOCK, AND IT IS THE ONLY ONE THERE IS.
 *
 * MEASURED 2026-08-12 by reading `supervisor.ts:1186`: `#repair` does
 * `outcome = await this.#deps.repair(...)` inside the tick, behind the
 * re-entrancy flag, with NO timeout of its own — `REPAIR_CYCLE_TIMEOUT_MS`
 * (`supervisor-boot.ts:267`) bounds the SPAWNED CYCLE, not the driver, and this
 * author runs BEFORE the spawn. So an author call that hangs stops every
 * subsequent tick: nothing reconciles, nothing wakes, nothing is claimed. That
 * is the failure the ten-minute cycle bound exists to prevent, arriving through
 * the door next to it.
 *
 * 60s + 180s = 240s, CHOSEN AND NOT MEASURED — no authoring call has ever been
 * made, so there is no distribution to quote. The survey turn is a short JSON
 * object and the authoring turn is a diff, which is why they differ. Together
 * they add 4 minutes to a repairing tick that already spends up to 10 in the
 * cycle. {@link withDeadline} enforces it OUTSIDE the seam, so an injected call
 * that never settles times out exactly like a hung subprocess would.
 */
export const SURVEY_TIMEOUT_MS = 60_000;
/** See {@link SURVEY_TIMEOUT_MS}. */
export const AUTHOR_TIMEOUT_MS = 180_000;

/**
 * THE WHOLE AUTHORING JOB'S SHARE OF THE TICKET'S WINDOW, AND THE ARITHMETIC
 * THAT HAS TO HOLD FOR ANY OF IT TO BE WORTH SPENDING.
 *
 *   AUTHOR_BUDGET_MS            240_000   this file, both turns
 * + REPAIR_CYCLE_TIMEOUT_MS     600_000   supervisor-boot.ts — the spawned cycle
 * = 840_000 < SUPERVISOR_REPAIR_DEADLINE_MS (1_800_000, supervisor.ts)
 *
 * with 16 minutes to spare. THE ORDERING IS THE POINT, not the margin: this
 * author runs BEFORE the cycle, and `decideRepairOutcome`'s window arm refuses
 * `REPAIR_WINDOW_CLOSED` at the cycle's entry "so no gate run is spent on a
 * ticket the supervisor is about to terminate anyway". An author that spent two
 * MODEL calls and then handed the cycle a closed window would have inverted that
 * rule — quota is dearer than a gate run — which is why
 * {@link authorRepairPatch} refuses before its first call when the window cannot
 * still be open when the cycle starts. `repair-author.test.ts` asserts the
 * inequality against the numbers read out of the two other modules, so closing
 * the gap is a RED test rather than a silent overrun.
 */
export const AUTHOR_BUDGET_MS = SURVEY_TIMEOUT_MS + AUTHOR_TIMEOUT_MS;

/** How many files the author may ask for, and may then change. */
export const MAX_REQUESTED_FILES = 4;
/** Per-file cap on what is sent into the prompt. `orchestrator.ts` is 409 KB. */
export const MAX_TARGET_BYTES = 96 * 1024;
/** Cap on all targets together, so N files cannot multiply past the per-file cap. */
export const MAX_TOTAL_TARGET_BYTES = 192 * 1024;
/** Cap on the emitted diff. A repair bigger than this is an owner's decision. */
export const MAX_DIFF_BYTES = 32 * 1024;

/**
 * PATHS THIS AUTHOR REFUSES, BY PREFIX, IN BOTH DIRECTIONS — the files it asks
 * for and the files its diff touches.
 *
 * IT IS A SUPERSET OF THE FROZEN CLOSURE AND SAYS SO. The real partition is
 * derived, not listed, by `tools/tier3/closure.mjs#frozenClosure`, and
 * MEASURED 2026-08-12 that module cannot be imported from here: adding
 * `import { frozenClosure } from "../../../tools/tier3/closure.mjs"` to a file
 * under `src/` fails `npm run typecheck` with
 *
 *   error TS7016: Could not find a declaration file for module
 *   '../../../tools/tier3/closure.mjs' … implicitly has an 'any' type.
 *
 * (`tsconfig.json` sets `rootDir: "src"`, `include: ["src/**\/*.ts"]`, `strict`.)
 * Transcribing that module's derived list here would be the hand-maintained copy
 * its own header warns drifts — and a drifted copy that under-refuses is the
 * direction that costs, because it lets the loop edit its own grader.
 *
 * So this list refuses WHOLE DIRECTORIES that contain the closure rather than
 * naming its members: `bakeoff/src/` is a strict superset of the derived grader
 * closure and its controls, `tools/tier3/` and `bakeoff/test/` cover the
 * admission set (`closure.mjs#ADMISSION_PREFIXES`), and the rest are the frozen
 * data prefixes plus the artefacts a "repair" could forge instead of earning.
 * Over-refusing costs a refused proposal with a named reason; under-refusing
 * costs the grader. Only one of those is recoverable.
 */
export const REFUSED_PATH_PREFIXES: ReadonlyArray<{ readonly prefix: string; readonly why: string }> =
  Object.freeze([
    Object.freeze({
      prefix: "tools/tier3/",
      why: "the Tier 3 gate — the only thing that authorises a patch to land. closure.mjs lists it in ADMISSION_PREFIXES: refused at every tier, never queued",
    }),
    Object.freeze({
      prefix: "tools/repair/",
      why: "the evidence bar and the ledger that will grade this very patch; an author editing its own grader is the collapse this whole lane is built to refuse",
    }),
    Object.freeze({
      prefix: "bakeoff/src/",
      why: "a superset of the frozen grader closure (scorer, gate, spec-freeze and their transitive imports) and its control files, refused as a directory because the derived list cannot be imported here",
    }),
    Object.freeze({
      prefix: "bakeoff/test/",
      why: "holds the impossible-ticket admission set; a movable anchor is not an anchor (closure.mjs, RESEARCH R10)",
    }),
    Object.freeze({
      prefix: "bakeoff/docker/",
      why: "the sealed scorer image and its harness config — frozen data (closure.mjs#FROZEN_DATA_PREFIXES)",
    }),
    Object.freeze({
      prefix: "dashboard/acceptance/",
      why: "the acceptance suites themselves. A run is scored against these, so editing one is passing by moving the target rather than by fixing anything",
    }),
    Object.freeze({
      prefix: "dashboard/server/src/calibration",
      why: "frozen calibration fixtures and their test (closure.mjs#FROZEN_DATA_PREFIXES)",
    }),
    Object.freeze({
      prefix: "dashboard/server/probes/",
      why: "frozen calibration probes and their recorded results (closure.mjs#FROZEN_DATA_PREFIXES)",
    }),
    Object.freeze({
      prefix: "dashboard/data/",
      why: "the gate's trail, the ruled-out ledger, the proposals and the rollback records — this lane's own bookkeeping, not source",
    }),
    Object.freeze({
      prefix: "dashboard/runs/",
      why: "recorded run artefacts. A defect record or a result edited to look healthy is a forged measurement, not a repair",
    }),
    Object.freeze({
      prefix: "dashboard/results/",
      why: "recorded scores. Same reason as dashboard/runs/",
    }),
  ]);

/** Non-null when the path is refused; the string is the reason, for the record. */
export function refusedPathReason(path: string): string | null {
  for (const entry of REFUSED_PATH_PREFIXES) {
    if (path === entry.prefix || path.startsWith(entry.prefix)) return entry.why;
  }
  return null;
}

/**
 * A model-supplied path, reduced to something that can be checked, or null.
 *
 * ABSOLUTE PATHS AND `..` ARE REJECTED RATHER THAN NORMALISED. `git show
 * HEAD:<path>` resolves from the repository root, so `../` would reach outside
 * the tree the diff is meant to describe, and an absolute path in a diff header
 * is not applicable by `git apply -p1` at all. Rejecting is also what keeps a
 * refused prefix from being reachable as `./tools/tier3/../tier3/gate.mjs`.
 */
export function normaliseRequestedPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^\.\//, "");
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  if (trimmed.includes("\\") || trimmed.includes("\0")) return null;
  if (trimmed.split("/").some((segment) => segment === "..")) return null;
  return trimmed;
}

export interface HeadFile {
  readonly path: string;
  readonly bytes: number;
  readonly text: string;
}

export interface HeadRead {
  readonly ok: boolean;
  readonly file: HeadFile | null;
  /** Why not, in a sentence that names the path. Never a stack trace. */
  readonly detail: string;
}

function git(repoRoot: string, args: readonly string[], maxBuffer: number): { ok: boolean; out: string; err: string } {
  const res = spawnSync("git", [...args], { cwd: repoRoot, encoding: "utf8", maxBuffer });
  return {
    ok: res.status === 0,
    out: typeof res.stdout === "string" ? res.stdout : "",
    err: typeof res.stderr === "string" ? res.stderr : res.error instanceof Error ? res.error.message : "",
  };
}

/** The commit the targets are read from and the diff is authored against. */
export function headSha(repoRoot: string): string | null {
  const res = git(repoRoot, ["rev-parse", "HEAD"], 4096);
  const sha = res.out.trim();
  return res.ok && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/**
 * One target file as HEAD has it.
 *
 * THE SIZE IS TAKEN BEFORE THE BYTES. `git cat-file -s` answers from the object
 * header, so an over-cap file is refused without reading it into this process —
 * which matters because the cap exists to bound the prompt, and reading 409 KB
 * to decide not to send it would put it in memory anyway.
 */
export function readAtHead(repoRoot: string, path: string, maxBytes: number = MAX_TARGET_BYTES): HeadRead {
  const size = git(repoRoot, ["cat-file", "-s", `HEAD:${path}`], 4096);
  if (!size.ok) {
    return {
      ok: false,
      file: null,
      detail: `${path} does not exist at HEAD (${size.err.trim().split("\n")[0] ?? "no such object"}), so nothing can be quoted from it`,
    };
  }
  const bytes = Number.parseInt(size.out.trim(), 10);
  if (!Number.isFinite(bytes)) {
    return { ok: false, file: null, detail: `git could not size ${path} at HEAD: ${truncate(size.out.trim(), 120)}` };
  }
  if (bytes > maxBytes) {
    return {
      ok: false,
      file: null,
      detail: `${path} is ${String(bytes)} bytes at HEAD, over the ${String(maxBytes)}-byte per-target cap, so it is not sent`,
    };
  }
  const show = git(repoRoot, ["show", `HEAD:${path}`], maxBytes + 4096);
  if (!show.ok) return { ok: false, file: null, detail: `git show HEAD:${path} failed: ${truncate(show.err.trim(), 160)}` };
  return { ok: true, file: { path, bytes, text: show.out }, detail: `read ${String(bytes)} bytes from HEAD:${path}` };
}

/* -------------------------------------------------------------------------
 * The two prompts
 * ---------------------------------------------------------------------- */

/**
 * The system prompt, frozen and identical for both turns (doc 04 §3.2: it is
 * the cache breakpoint, so nothing per-request may be interpolated into it).
 *
 * NO ANTI-CHEATING SCOLDING, for the reason `fix-prompt.ts` and
 * `build-prompt.ts` both carry: Anthropic measured that "only dangerously
 * misaligned AIs would hack" framing produced HIGHER misalignment than neutral
 * framing (doc 02 §5.6). What replaces it is mechanical and TRUE — the refused
 * paths really are refused, by {@link refusedPathReason}, before a byte is sent
 * or read — because an author that does not know the shape of the bound wastes
 * its turn discovering it.
 */
export const PATCH_AUTHOR_SYSTEM_PROMPT = [
  "You propose ONE candidate patch for a defect in a repository you cannot run.",
  "",
  "WHAT HAPPENS TO YOUR ANSWER. It is written to a file as a candidate diff. A separate process you",
  "cannot see, call or influence then copies the repository at HEAD into a temporary directory,",
  "reproduces the defect there, applies your patch, re-runs the reproduction, and finally reverts your",
  "fix to check the failure comes back. Only after that does a gate decide whether anything lands.",
  "Your answer changes no file on this machine by itself, and no part of that grading is yours.",
  "",
  "WHAT YOU ARE GIVEN. A defect record, and the exact bytes of a few files as the last commit has",
  "them. Nothing else exists for you: this seat has no tools, so it cannot open a file, run a command",
  "or search the tree. If the evidence does not support a patch, say so — an honest refusal is a",
  "recorded outcome here, and a plausible guess is graded as a failed repair against this defect.",
  "",
  "WHAT IS OUT OF BOUNDS, MECHANICALLY. Paths under tools/tier3/, tools/repair/, bakeoff/src/,",
  "bakeoff/test/, bakeoff/docker/, dashboard/acceptance/, dashboard/data/, dashboard/runs/ and",
  "dashboard/results/ are rejected by the program that reads this answer, before any model sees them",
  "again: they are the grader, the acceptance suites and the recorded results. Asking for one ends",
  "this attempt with that path named in the record. The acceptance suite is not in this prompt and",
  "editing it would change nothing that is scored.",
  "",
  "THE PATCH MUST APPLY TO THE BYTES YOU ARE GIVEN. They are the committed bytes, not a working copy.",
  "Copy context lines verbatim from them; do not reflow, re-indent or summarise unchanged lines.",
].join("\n");

/** The evidence the author gets: the defect record, bounded, and nothing else. */
export function renderDefectBrief(defect: Record<string, unknown>): string {
  const str = (key: string): string => {
    const value = defect[key];
    return typeof value === "string" && value.trim() !== "" ? value : "(none recorded)";
  };
  const list = (key: string): readonly unknown[] => {
    const value = defect[key];
    return Array.isArray(value) ? value : [];
  };
  const lines: string[] = [
    "THE DEFECT RECORD",
    `  signature      ${str("signature")}`,
    `  phase/status   ${str("phase")} / ${str("status")}`,
    `  failure class  ${str("failureClass")} (bakeoff code: ${str("bakeoffCode")})`,
    `  site           ${str("site")}`,
  ];

  const violations = list("violations");
  if (violations.length > 0) {
    lines.push("", "STRUCTURED VIOLATIONS");
    for (const raw of violations.slice(0, 12)) {
      const v = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      lines.push(
        `  - ${String(v["path"] ?? "(no path)")}: expected ${truncate(String(v["expected"] ?? "?"), 200)} / got ${truncate(String(v["got"] ?? "?"), 200)}`,
      );
    }
  }

  const fieldPaths = list("fieldPaths");
  if (fieldPaths.length > 0) {
    lines.push("", `FIELD PATHS NAMED BY THE FAILURE: ${fieldPaths.slice(0, 20).map((p) => String(p)).join(", ")}`);
  }

  const attempts = list("attempts");
  if (attempts.length > 0) {
    lines.push("", "WHAT HAS ALREADY BEEN TRIED, IN ORDER (these did not work)");
    for (const raw of attempts.slice(0, 6)) {
      const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const problems = Array.isArray(a["problems"]) ? a["problems"] : [];
      lines.push(`  attempt ${String(a["n"] ?? "?")}: ${truncate(problems.map((p) => String(p)).join(" | "), 600)}`);
    }
  }

  const failureReason = defect["failureReason"];
  lines.push(
    "",
    "WHAT THE LAYER THAT THREW ACTUALLY SAID",
    typeof failureReason === "string" && failureReason.trim() !== ""
      ? truncate(failureReason, 6_000)
      : "  (the record carries no failure reason)",
  );

  const unavailable = list("unavailable");
  if (unavailable.length > 0) {
    lines.push("", "WHAT IS MISSING FROM THIS RECORD, AND WHY (do not treat absence as absence of a problem)");
    for (const note of unavailable.slice(0, 6)) lines.push(`  - ${truncate(String(note), 400)}`);
  }

  /*
   * ARTEFACT PATHS ARE WITHHELD AND SAID TO BE WITHHELD. `defect.artefacts` is a
   * list of ABSOLUTE host paths (measured, in all 7 records under
   * `dashboard/runs`), and `ticket-refs.ts` already forbids putting an absolute
   * host path in front of a seat. A blank where evidence should be reads as
   * "there was nothing", so it says which and why instead.
   */
  lines.push(
    "",
    "The record also lists artefact files. Their paths are absolute host paths and are withheld for that",
    "reason; this seat could not open them anyway.",
  );
  return lines.join("\n");
}

/** Phase 1: which files does this defect implicate? Names only, no patch. */
export function renderSurveyTurn(defect: Record<string, unknown>): string {
  return [
    renderDefectBrief(defect),
    "",
    "STEP 1 OF 2 — NAME THE FILES.",
    `Reply with ONE JSON object and nothing else: {"files": ["<repo-relative path>", ...], "why": "<one sentence>"}.`,
    `At most ${String(MAX_REQUESTED_FILES)} paths, repository-relative (for example "dashboard/server/src/preview.ts"),`,
    "each one you believe must change to fix THIS defect. They will be read from the last commit and sent",
    "back to you verbatim in step 2; a path that does not exist there is dropped and named in the record.",
    `Answer {"files": [], "why": "..."} if this record does not support naming any file — that is recorded`,
    "as a refusal to guess, and it is a better outcome than a patch to a file that is not implicated.",
  ].join("\n");
}

/** Phase 2: here are the committed bytes; emit the diff. */
export function renderAuthorTurn(
  defect: Record<string, unknown>,
  files: readonly HeadFile[],
  sha: string,
): string {
  const blocks = files.map((f) => `----- BEGIN ${f.path} (${String(f.bytes)} bytes at ${sha}) -----\n${f.text}\n----- END ${f.path} -----`);
  return [
    renderDefectBrief(defect),
    "",
    `THE FILES YOU ASKED FOR, EXACTLY AS COMMIT ${sha} HAS THEM`,
    "",
    ...blocks,
    "",
    "STEP 2 OF 2 — EMIT THE PATCH.",
    "Reply with a unified diff and nothing else — no explanation before or after it. Use `--- a/<path>`",
    "and `+++ b/<path>` headers with the repository-relative paths above, standard `@@` hunks and three",
    "lines of context. It must apply with `git apply -p1` against the bytes printed above, so context",
    "lines have to match them character for character.",
    `You may change only those files (at most ${String(MAX_REQUESTED_FILES)}), and the whole diff must be under ${String(MAX_DIFF_BYTES)} bytes.`,
    "Do not delete a file. Do not add a test that asserts the behaviour you just wrote — the evidence bar",
    "runs the defect's own reproduction, and a test written alongside the fix is not independent of it.",
  ].join("\n");
}

/* -------------------------------------------------------------------------
 * Reading the model's two answers
 * ---------------------------------------------------------------------- */

/**
 * The first JSON object in an answer. Same shape `judge.ts` uses, and for the
 * same reason: a free-form call is one fewer request constraint to be wrong
 * about, and a model that wraps its object in prose or a fence is common.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The diff in an answer, from a fenced block or from the first file header on.
 *
 * A TRAILING NEWLINE IS ALWAYS ADDED: `git apply` refuses a truncated patch
 * (`diff.mjs#splitHunks` says the same about its own output), and a model that
 * ends its last line without one would otherwise produce a diff that is refused
 * for a reason having nothing to do with the repair.
 *
 * THE HUNK TEST HERE IS DELIBERATELY LOOSER THAN {@link diffShape}'s. This
 * function decides whether the answer contained a patch at all; a malformed
 * `@@ …` line means it did, badly, and the honest refusal for that is
 * `DIFF_UNPARSEABLE` from the checker rather than `NO_DIFF_IN_ANSWER` from here.
 * The two codes say different things to whoever reads the journal.
 */
export function extractDiff(text: string): string | null {
  const candidates: string[] = [];
  const fence = /```(?:diff|patch)?\r?\n([\s\S]*?)```/g;
  let match = fence.exec(text);
  while (match !== null) {
    if (typeof match[1] === "string") candidates.push(match[1]);
    match = fence.exec(text);
  }
  candidates.push(text);
  for (const candidate of candidates) {
    const lines = candidate.split("\n");
    const at = lines.findIndex((line, i) => line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ "));
    if (at < 0) continue;
    const body = lines.slice(at).join("\n").replace(/```[\s\S]*$/, "");
    if (!/^@@ /m.test(body)) continue;
    return body.endsWith("\n") ? body : `${body}\n`;
  }
  return null;
}

export interface DiffShape {
  readonly files: readonly string[];
  readonly hunks: number;
  readonly deletes: readonly string[];
}

/**
 * The paths and hunks a diff really touches.
 *
 * A SECOND READER, DELIBERATELY, AND NOT A SECOND OPINION. `diff.mjs#filesInDiff`
 * is the reader the bar uses, and it is an `.mjs` this build cannot import (the
 * TS7016 measurement in {@link REFUSED_PATH_PREFIXES}). Its answer is the one
 * that decides anything downstream; this one exists only to REFUSE earlier and
 * more cheaply, so where they disagree the refusal happens here and the diff
 * never reaches the bar.
 *
 * {@link HUNK_HEADER} IS `diff.mjs`'s OWN REGEX, CHARACTER FOR CHARACTER, and
 * that is not decoration. MEASURED while writing this file: a looser
 * `line.startsWith("@@ ")` accepted `@@ not a hunk header @@` and this author
 * happily wrote the diff out — where `parseUnifiedDiff` THROWS "file … has no
 * hunks", which is the exact input that crashed `runSupervisorCycle` on
 * 2026-08-12 before that throw was caught. A reader that is more permissive than
 * the parser downstream hands the downstream the thing it cannot read.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

export function diffShape(diff: string): DiffShape {
  const files = new Set<string>();
  const deletes = new Set<string>();
  let hunks = 0;
  const lines = diff.split("\n");
  const strip = (raw: string): string => raw.split("\t")[0]?.trim().replace(/^[abciow]\//, "") ?? "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (HUNK_HEADER.test(line)) {
      hunks += 1;
      continue;
    }
    if (!line.startsWith("--- ") || !(lines[i + 1] ?? "").startsWith("+++ ")) continue;
    const oldPath = strip(line.slice(4));
    const newPath = strip((lines[i + 1] ?? "").slice(4));
    if (newPath === "/dev/null") {
      deletes.add(oldPath);
      files.add(oldPath);
    } else {
      files.add(newPath);
    }
    i += 1;
  }
  return { files: [...files].sort(), hunks, deletes: [...deletes].sort() };
}

export interface DiffCheck {
  readonly ok: boolean;
  readonly code: string;
  readonly detail: string;
  readonly files: readonly string[];
}

/**
 * Every rule the emitted diff has to satisfy, checked in the order that spends
 * the least before refusing.
 *
 * THE GRADER CHECK RUNS AGAIN HERE EVEN THOUGH PHASE 1 ALREADY REFUSED THOSE
 * PATHS. Phase 1 bounds what is READ; this bounds what is WRITTEN, and the two
 * are not the same set: a model that asked for one file may emit a diff for
 * another. `granted` catches that in general, and the explicit prefix check
 * catches it with the right NAME — "this touched the grader" is a different
 * fact from "this touched a file it was not given", and the record has to say
 * which.
 */
export function checkAuthoredDiff(diff: string, granted: readonly string[]): DiffCheck {
  const shape = diffShape(diff);
  if (shape.files.length === 0 || shape.hunks === 0) {
    return {
      ok: false,
      code: "DIFF_UNPARSEABLE",
      detail: `the answer contained something diff-shaped with ${String(shape.files.length)} file header(s) and ${String(shape.hunks)} hunk(s); a patch needs at least one of each`,
      files: shape.files,
    };
  }
  const grader = shape.files.map((f) => ({ path: f, why: refusedPathReason(f) })).filter((f) => f.why !== null);
  if (grader.length > 0) {
    return {
      ok: false,
      code: "DIFF_TOUCHES_GRADER",
      detail:
        `the proposed patch changes ${grader.map((f) => f.path).join(", ")}, which this author refuses by name: ` +
        `${grader[0]?.why ?? ""}. A self-repair loop editing the component that grades it is not a repair.`,
      files: shape.files,
    };
  }
  const ungranted = shape.files.filter((f) => !granted.includes(f));
  if (ungranted.length > 0) {
    return {
      ok: false,
      code: "DIFF_TOUCHES_UNREQUESTED_FILE",
      detail:
        `the proposed patch changes ${ungranted.join(", ")}, which was never read at HEAD and never sent — so its ` +
        "context lines are invented, and nothing here knows what those files contain",
      files: shape.files,
    };
  }
  if (shape.deletes.length > 0) {
    return {
      ok: false,
      code: "DIFF_DELETES_FILE",
      detail: `the proposed patch deletes ${shape.deletes.join(", ")}; a deletion is an owner's decision, not an unattended one`,
      files: shape.files,
    };
  }
  if (shape.files.length > MAX_REQUESTED_FILES) {
    return {
      ok: false,
      code: "DIFF_TOO_MANY_FILES",
      detail: `the proposed patch changes ${String(shape.files.length)} files, over the bound of ${String(MAX_REQUESTED_FILES)}`,
      files: shape.files,
    };
  }
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes > MAX_DIFF_BYTES) {
    return {
      ok: false,
      code: "DIFF_TOO_LARGE",
      detail: `the proposed patch is ${String(bytes)} bytes, over the bound of ${String(MAX_DIFF_BYTES)}`,
      files: shape.files,
    };
  }
  return { ok: true, code: "DIFF_ACCEPTED", detail: `${String(shape.hunks)} hunk(s) across ${shape.files.join(", ")}`, files: shape.files };
}

/* -------------------------------------------------------------------------
 * The call seam
 * ---------------------------------------------------------------------- */

export interface PatchAuthorCallRequest {
  readonly system: string;
  readonly userTurns: readonly string[];
  readonly maxOutputTokens: number;
  readonly purpose: string;
  readonly timeoutMs: number;
}

export interface PatchAuthorCallResult {
  readonly text: string;
  readonly stopReason: string | null;
  /**
   * The model the seam really used. RECORDED RATHER THAN ASSUMED: the id is
   * resolved from the environment at call time ({@link patchAuthorSeat}), so a
   * journal row naming a constant would name whatever this file was compiled
   * with instead of what answered.
   */
  readonly modelId?: string;
}

/** One model call. Injected so no test ever spends quota. */
export type PatchAuthorCall = (request: PatchAuthorCallRequest) => Promise<PatchAuthorCallResult>;

/**
 * The production seam: the same `SubscriptionSeatCaller` every other seat uses,
 * on the same `SpendCeiling` (`newAuthoringCeiling(DASHBOARD_BUDGET)`).
 *
 * A FRESH CALLER PER CALL, BECAUSE THE ABORT CONTROLLER IS PER CALLER. Aborting
 * the survey turn on its deadline would otherwise kill the authoring turn made
 * on the same instance. Construction plans zero documents and zero images, so it
 * is cheap.
 *
 * `assertUnused()` AFTER EVERY CALL. MEASURED by reading
 * `subscription-caller.ts:2161`: it asserts only that the BASE class recorded no
 * usage — i.e. that no code path reached the metered API with the placeholder
 * credential. It does not forbid a second call, which is why the two-turn shape
 * is legal on this machinery.
 */
export function createSeatPatchAuthorCall(deps: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): PatchAuthorCall {
  return async (request: PatchAuthorCallRequest): Promise<PatchAuthorCallResult> => {
    const abortController = new AbortController();
    const timer = setTimeout(() => { abortController.abort(); }, request.timeoutMs);
    timer.unref();
    const seat = patchAuthorSeat(deps.env);
    try {
      const caller = new SubscriptionSeatCaller(seat, {
        budget: DASHBOARD_BUDGET,
        ceiling: newAuthoringCeiling(DASHBOARD_BUDGET),
        cwd: deps.cwd,
        env: deps.env,
        abortController,
      });
      const result = await caller.call({
        system: request.system,
        userTurns: request.userTurns,
        maxOutputTokens: request.maxOutputTokens,
        jsonSchema: null,
        purpose: request.purpose,
      });
      caller.assertUnused();
      return { text: result.text, stopReason: result.stopReason, modelId: seat.modelId };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * A bound on one awaited call, enforced OUTSIDE the seam.
 *
 * The production seam aborts its own subprocess on the same clock; this exists
 * because an abort the SDK ignores would still hang the tick, and because an
 * injected seam in a test has no subprocess to abort. The timer is unref'd so
 * an author that answered in time cannot hold the process open.
 */
export async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<{ readonly timedOut: boolean; readonly value: T | null }> {
  let timer: NodeJS.Timeout | null = null;
  const guard = new Promise<{ readonly timedOut: true; readonly value: null }>((resolve) => {
    timer = setTimeout(() => { resolve({ timedOut: true, value: null }); }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false, value }) as const), guard]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------
 * The record every attempt leaves
 * ---------------------------------------------------------------------- */

export interface AuthorJournalRow {
  readonly at: string;
  readonly runId: string | null;
  readonly signature: string;
  readonly kind: AuthorOutcomeKind;
  readonly code: string;
  readonly detail: string;
  readonly headSha: string | null;
  readonly requested: readonly string[];
  readonly rejected: readonly string[];
  readonly granted: readonly string[];
  readonly filesChanged: readonly string[];
  readonly diffPath: string | null;
  readonly diffBytes: number;
  /**
   * What answered, or `null` when nothing was called. NULL IS A FACT AND NOT A
   * GAP: the cheapest refusals happen before any call, and a row naming a model
   * that never ran would make "we refused for free" unreadable in the journal.
   */
  readonly modelId: string | null;
  readonly stopReason: string | null;
}

/**
 * Append one row, and NEVER lose the outcome to a failed write.
 *
 * The brief's rule is that every attempt including a refusal is recorded, so a
 * journal that cannot be written is itself a fact the caller has to be able to
 * report — it returns the failure instead of throwing it, and
 * {@link authorRepairPatch} appends that sentence to the outcome's detail. A
 * refusal that vanished because its record could not be written is
 * indistinguishable from an attempt that never happened.
 */
export function appendAuthorJournal(journalDir: string, row: AuthorJournalRow): { readonly ok: boolean; readonly path: string; readonly detail: string } {
  const path = join(journalDir, `${row.signature === "" ? "unattributed" : row.signature}.jsonl`);
  try {
    mkdirSync(journalDir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
    return { ok: true, path, detail: `recorded in ${path}` };
  } catch (error) {
    return { ok: false, path, detail: `the attempt could NOT be recorded in ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/* -------------------------------------------------------------------------
 * The author
 * ---------------------------------------------------------------------- */

export type AuthorOutcomeKind = "authored" | "refused" | "inconclusive";

export interface AuthorOutcome {
  readonly kind: AuthorOutcomeKind;
  readonly code: string;
  readonly detail: string;
  /** Where the candidate diff was written, on `authored` only. */
  readonly diffPath: string | null;
  readonly filesChanged: readonly string[];
  readonly headSha: string | null;
  readonly journalPath: string | null;
}

export interface AuthorRepairInput {
  /** `<runsDir>/<runId>/results/defect.json`. */
  readonly defectPath: string;
  /** Where the cycle looks for `<signature>.diff`. */
  readonly proposalsDir: string;
  readonly journalDir: string;
  /** The git tree the targets are read from. */
  readonly repoRoot: string;
  readonly call: PatchAuthorCall;
  readonly runId?: string | null;
  /**
   * The instant after which the ticket leaves `repairing` regardless
   * (`SupervisorRepairRequest.deadlineAt`). ABSENT MEANS UNBOUNDED, which is
   * what a direct caller with no ticket gets; it is never read as "expired",
   * because a missing clock must not refuse work a real window would allow.
   */
  readonly deadlineAt?: string | null;
  readonly now?: () => Date;
  readonly surveyTimeoutMs?: number;
  readonly authorTimeoutMs?: number;
}

const HEX_SIGNATURE = /^[a-f0-9]{8,128}$/i;

/**
 * ONE authoring attempt: defect record in, a candidate diff on disk or a NAMED
 * refusal out. It never applies, proves, grades or gates anything.
 *
 * THE ORDER OF THE CHECKS IS THE COST ORDER. Everything that can refuse without
 * a model call happens first — no record, no signature, a proposal already on
 * disk, a record with no evidence in it at all — because each of those would
 * otherwise spend a seat call to be told what this process already knows.
 */
export async function authorRepairPatch(input: AuthorRepairInput): Promise<AuthorOutcome> {
  const now = input.now ?? (() => new Date());
  const runId = input.runId ?? null;
  /** Set by whichever call answered last; see {@link AuthorJournalRow.modelId}. */
  let answeredBy: string | null = null;

  const finish = (
    partial: Omit<AuthorOutcome, "journalPath">,
    extra: {
      readonly signature: string;
      readonly requested?: readonly string[];
      readonly rejected?: readonly string[];
      readonly granted?: readonly string[];
      readonly diffBytes?: number;
      readonly stopReason?: string | null;
    },
  ): AuthorOutcome => {
    const journal = appendAuthorJournal(input.journalDir, {
      at: now().toISOString(),
      runId,
      signature: extra.signature,
      kind: partial.kind,
      code: partial.code,
      detail: partial.detail,
      headSha: partial.headSha,
      requested: extra.requested ?? [],
      rejected: extra.rejected ?? [],
      granted: extra.granted ?? [],
      filesChanged: partial.filesChanged,
      diffPath: partial.diffPath,
      diffBytes: extra.diffBytes ?? 0,
      modelId: answeredBy,
      stopReason: extra.stopReason ?? null,
    });
    return {
      ...partial,
      detail: journal.ok ? partial.detail : `${partial.detail} (${journal.detail})`,
      journalPath: journal.ok ? journal.path : null,
    };
  };

  let defect: Record<string, unknown> | null = null;
  if (existsSync(input.defectPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(input.defectPath, "utf8"));
      defect = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      defect = null;
    }
  }
  const blank = { diffPath: null, filesChanged: [] as readonly string[], headSha: null };
  if (defect === null) {
    return finish(
      {
        ...blank,
        kind: "inconclusive",
        code: "NO_DEFECT_RECORD",
        detail: `no readable defect record at ${input.defectPath}, so there is no failure to author against and a patch would be a guess`,
      },
      { signature: "" },
    );
  }
  const signature = typeof defect["signature"] === "string" ? defect["signature"] : "";
  if (!HEX_SIGNATURE.test(signature)) {
    return finish(
      {
        ...blank,
        kind: "inconclusive",
        code: "NO_DEFECT_SIGNATURE",
        detail:
          `the defect record at ${input.defectPath} carries no hex signature (${JSON.stringify(signature)}), and the cycle reads ` +
          "the candidate diff from a path named by that digest — so an authored patch would be written where nothing looks for it",
      },
      { signature: "" },
    );
  }

  /*
   * THE WINDOW IS CHECKED BEFORE ANYTHING IS SPENT, AND IN TWO ARMS.
   *
   * `supervisor-cycle.mjs#decideRepairOutcome` already refuses
   * `REPAIR_WINDOW_CLOSED` at the CYCLE's entry, for the stated reason that no
   * gate run should be spent on a ticket about to be terminated. This author
   * runs in front of that check and spends model calls, so the same rule has to
   * hold here first and one step earlier: a window with less time left than this
   * job needs is a window the cycle will find CLOSED when it starts, and a diff
   * the cycle refuses on sight was authored for nothing.
   */
  const budgetMs = (input.surveyTimeoutMs ?? SURVEY_TIMEOUT_MS) + (input.authorTimeoutMs ?? AUTHOR_TIMEOUT_MS);
  const deadlineMs =
    typeof input.deadlineAt === "string" && input.deadlineAt.trim() !== "" ? new Date(input.deadlineAt).getTime() : Number.NaN;
  if (Number.isFinite(deadlineMs)) {
    const remaining = deadlineMs - now().getTime();
    if (remaining <= 0) {
      return finish(
        {
          ...blank,
          kind: "inconclusive",
          code: "REPAIR_WINDOW_CLOSED",
          detail:
            `the repair window for defect ${signature} closed at ${input.deadlineAt ?? ""}, so no model call was made. The ticket ` +
            "is about to be terminated by the supervisor's own clock and a patch authored now would be graded by nothing.",
        },
        { signature },
      );
    }
    if (remaining <= budgetMs) {
      return finish(
        {
          ...blank,
          kind: "inconclusive",
          code: "REPAIR_WINDOW_TOO_SHORT",
          detail:
            `the repair window for defect ${signature} has ${String(Math.round(remaining / 1_000))}s left and authoring is bounded at ` +
            `${String(Math.round(budgetMs / 1_000))}s, so the window would be closed before the evidence bar could start. ` +
            "supervisor-cycle.mjs refuses REPAIR_WINDOW_CLOSED at its own entry, so the two model calls would buy a diff nothing grades.",
        },
        { signature },
      );
    }
  }

  const diffPath = join(input.proposalsDir, `${signature}.diff`);
  if (existsSync(diffPath)) {
    return finish(
      {
        ...blank,
        kind: "inconclusive",
        code: "PROPOSAL_ALREADY_EXISTS",
        /*
         * AND THE COST OF THAT CHOICE, NAMED RATHER THAN LEFT TO BE FOUND. A diff
         * the bar or the gate REFUSED also stays on disk, so cycle 2 against the
         * same signature re-reads it and stops at `ALREADY_RULED_OUT` — the
         * ticket gets one idea, not `SUPERVISOR_REPAIR_MAX_PER_SIGNATURE` of
         * them. Retiring a ruled-out proposal so a second can be authored means
         * reading the ledger's verdict for this fingerprint, and that is a
         * deliberate non-goal this round: the author would then be consulting the
         * grader's record, which is one short step from being shaped by it.
         * Carried forward, unbuilt, and UNMEASURED — no candidate diff has yet
         * been authored, so how often a second idea would help is not known.
         */
        detail:
          `a candidate diff for ${signature} is already at ${diffPath} and is left exactly as it is. A proposal is an INPUT ` +
          "the owner may have written or edited by hand, and overwriting one would silently discard it; the cycle grades what is there.",
      },
      { signature },
    );
  }

  /*
   * A RECORD WITH NO EVIDENCE IN IT REFUSES WITHOUT SPENDING A CALL, and this is
   * not a hypothetical arm. MEASURED 2026-08-12: `dashboard/runs/run-2026-08-12T07-34-18-997Z-d143e52d/results/defect.json`
   * has `violations: []`, `attempts: []`, `fieldPaths: []` and `failureReason: null` —
   * its own `unavailable` notes say the structured detail never travelled. There
   * is nothing in it to author from, and a seat asked anyway would answer from
   * `failureClass: "unclassified"` and the file list it cannot see.
   */
  const hasEvidence =
    (typeof defect["failureReason"] === "string" && defect["failureReason"].trim() !== "") ||
    (Array.isArray(defect["violations"]) && defect["violations"].length > 0) ||
    (Array.isArray(defect["fieldPaths"]) && defect["fieldPaths"].length > 0) ||
    (Array.isArray(defect["attempts"]) && defect["attempts"].length > 0);
  if (!hasEvidence) {
    return finish(
      {
        ...blank,
        kind: "refused",
        code: "NOTHING_ACTIONABLE",
        detail:
          `defect ${signature} carries no failure reason, no structured violation, no field path and no attempt history, so ` +
          "nothing in it names anything to change. No model call was made: a patch authored from a failure class alone is a " +
          "guess, and a guess is graded as a failed repair against this signature.",
      },
      { signature },
    );
  }

  const sha = headSha(input.repoRoot);
  if (sha === null) {
    return finish(
      {
        ...blank,
        kind: "inconclusive",
        code: "NO_HEAD_COMMIT",
        detail:
          `${input.repoRoot} has no resolvable HEAD, so no file can be quoted from the commit the evidence bar will copy ` +
          "(isolate.mjs builds its tree with `git archive HEAD`). Authoring against the working tree would produce a diff that cannot apply there.",
      },
      { signature },
    );
  }

  // ─── PHASE 1: which files? ───
  let survey: PatchAuthorCallResult;
  try {
    const raced = await withDeadline(
      input.call({
        system: PATCH_AUTHOR_SYSTEM_PROMPT,
        userTurns: [renderSurveyTurn(defect)],
        maxOutputTokens: SURVEY_MAX_OUTPUT_TOKENS,
        purpose: `repair patch author: file survey for defect ${signature}`,
        timeoutMs: input.surveyTimeoutMs ?? SURVEY_TIMEOUT_MS,
      }),
      input.surveyTimeoutMs ?? SURVEY_TIMEOUT_MS,
    );
    if (raced.timedOut || raced.value === null) {
      return finish(
        {
          ...blank,
          headSha: sha,
          kind: "inconclusive",
          code: "AUTHOR_TIMED_OUT",
          detail:
            `the file survey for defect ${signature} did not answer within ${String(input.surveyTimeoutMs ?? SURVEY_TIMEOUT_MS)}ms and was abandoned. ` +
            "The bound exists because SupervisorLoop.#repair awaits this call inside a tick with no clock of its own, so a hang here stops the whole queue.",
        },
        { signature },
      );
    }
    survey = raced.value;
    answeredBy = survey.modelId ?? answeredBy;
  } catch (error) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "inconclusive",
        code: "AUTHOR_CALL_FAILED",
        detail: `the file survey for defect ${signature} failed: ${truncate(error instanceof Error ? error.message : String(error), 400)}`,
      },
      { signature },
    );
  }

  const answer = extractJsonObject(survey.text);
  if (answer === null) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "inconclusive",
        code: "SURVEY_UNREADABLE",
        detail: `the file survey for defect ${signature} answered no JSON object: ${truncate(survey.text, 300)}`,
      },
      { signature, stopReason: survey.stopReason },
    );
  }
  const rawFiles = Array.isArray(answer["files"]) ? answer["files"] : [];
  const requested = rawFiles.map((raw) => normaliseRequestedPath(raw)).filter((p): p is string => p !== null);
  if (requested.length === 0) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "refused",
        code: "AUTHOR_NAMED_NO_FILES",
        detail:
          `asked which files defect ${signature} implicates, the author named none it could use: ` +
          `${truncate(typeof answer["why"] === "string" ? answer["why"] : survey.text, 400)}. No patch was invented to fill the gap.`,
      },
      { signature, stopReason: survey.stopReason },
    );
  }
  if (requested.length > MAX_REQUESTED_FILES) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "refused",
        code: "TOO_MANY_FILES_REQUESTED",
        detail:
          `the author asked for ${String(requested.length)} files (${requested.join(", ")}), over the bound of ${String(MAX_REQUESTED_FILES)}. ` +
          "A repair that spans more files than that is a redesign, and the bar's mutation check cannot attribute it.",
      },
      { signature, requested, stopReason: survey.stopReason },
    );
  }

  /*
   * THE REFUSAL THAT SAVES THE SECOND CALL. A requested grader path ends the
   * attempt here, by name, before anything is read or sent — which is the
   * enforcement of "the author may not be given anything that lets it weaken a
   * gate". `checkAuthoredDiff` is the same rule applied to what comes back, and
   * both arms are needed: this one bounds what is READ, that one bounds what is
   * WRITTEN.
   */
  const graderAsk = requested.map((path) => ({ path, why: refusedPathReason(path) })).filter((f) => f.why !== null);
  if (graderAsk.length > 0) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "refused",
        code: "REQUESTED_GRADER_FILE",
        detail:
          `the author asked to read ${graderAsk.map((f) => f.path).join(", ")}, which this lane refuses by name: ` +
          `${graderAsk[0]?.why ?? ""}. Nothing was read and no second call was made.`,
      },
      { signature, requested, rejected: graderAsk.map((f) => f.path), stopReason: survey.stopReason },
    );
  }

  const targets: HeadFile[] = [];
  const rejected: string[] = [];
  const notes: string[] = [];
  let total = 0;
  for (const path of requested) {
    const read = readAtHead(input.repoRoot, path);
    if (!read.ok || read.file === null) {
      rejected.push(path);
      notes.push(read.detail);
      continue;
    }
    if (total + read.file.bytes > MAX_TOTAL_TARGET_BYTES) {
      rejected.push(path);
      notes.push(`${path} would take the prompt past the ${String(MAX_TOTAL_TARGET_BYTES)}-byte total target cap, so it is not sent`);
      continue;
    }
    total += read.file.bytes;
    targets.push(read.file);
  }
  if (targets.length === 0) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "refused",
        code: "NO_READABLE_TARGET",
        detail:
          `none of the files the author asked for could be read from ${sha}: ${notes.join("; ")}. A patch to a file that is not ` +
          "in the commit the evidence bar copies could never apply there.",
      },
      { signature, requested, rejected, stopReason: survey.stopReason },
    );
  }

  // ─── PHASE 2: the diff ───
  const granted = targets.map((t) => t.path);
  let authored: PatchAuthorCallResult;
  try {
    const raced = await withDeadline(
      input.call({
        system: PATCH_AUTHOR_SYSTEM_PROMPT,
        userTurns: [renderAuthorTurn(defect, targets, sha)],
        maxOutputTokens: AUTHOR_MAX_OUTPUT_TOKENS,
        purpose: `repair patch author: candidate diff for defect ${signature}`,
        timeoutMs: input.authorTimeoutMs ?? AUTHOR_TIMEOUT_MS,
      }),
      input.authorTimeoutMs ?? AUTHOR_TIMEOUT_MS,
    );
    if (raced.timedOut || raced.value === null) {
      return finish(
        {
          ...blank,
          headSha: sha,
          kind: "inconclusive",
          code: "AUTHOR_TIMED_OUT",
          detail:
            `the authoring turn for defect ${signature} did not answer within ${String(input.authorTimeoutMs ?? AUTHOR_TIMEOUT_MS)}ms and was abandoned. ` +
            "The bound exists because SupervisorLoop.#repair awaits this call inside a tick with no clock of its own.",
        },
        { signature, requested, rejected, granted },
      );
    }
    authored = raced.value;
    answeredBy = authored.modelId ?? answeredBy;
  } catch (error) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "inconclusive",
        code: "AUTHOR_CALL_FAILED",
        detail: `the authoring turn for defect ${signature} failed: ${truncate(error instanceof Error ? error.message : String(error), 400)}`,
      },
      { signature, requested, rejected, granted },
    );
  }

  const diff = extractDiff(authored.text);
  if (diff === null) {
    return finish(
      {
        ...blank,
        headSha: sha,
        kind: "refused",
        code: "NO_DIFF_IN_ANSWER",
        detail:
          `the authoring turn for defect ${signature} produced no unified diff` +
          `${authored.stopReason === "max_tokens" ? " and hit the output ceiling, so what came back is truncated" : ""}: ` +
          truncate(authored.text, 300),
      },
      { signature, requested, rejected, granted, stopReason: authored.stopReason },
    );
  }
  const check = checkAuthoredDiff(diff, granted);
  if (!check.ok) {
    return finish(
      {
        diffPath: null,
        filesChanged: check.files,
        headSha: sha,
        kind: "refused",
        code: check.code,
        detail: `${check.detail} (defect ${signature}; nothing was written to ${diffPath})`,
      },
      { signature, requested, rejected, granted, diffBytes: Buffer.byteLength(diff, "utf8"), stopReason: authored.stopReason },
    );
  }

  try {
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, diff, "utf8");
  } catch (error) {
    return finish(
      {
        diffPath: null,
        filesChanged: check.files,
        headSha: sha,
        kind: "inconclusive",
        code: "PROPOSAL_UNWRITABLE",
        detail: `a candidate diff for defect ${signature} was authored and could not be written to ${diffPath}: ${error instanceof Error ? error.message : String(error)}`,
      },
      { signature, requested, rejected, granted, diffBytes: Buffer.byteLength(diff, "utf8"), stopReason: authored.stopReason },
    );
  }

  return finish(
    {
      diffPath,
      filesChanged: check.files,
      headSha: sha,
      kind: "authored",
      code: "PATCH_AUTHORED",
      detail:
        `a candidate diff for defect ${signature} was written to ${diffPath}: ${check.detail}, authored against ${sha}. ` +
        "It has been graded by nothing — the evidence bar and the Tier 3 gate decide what happens to it.",
    },
    { signature, requested, rejected, granted, diffBytes: Buffer.byteLength(diff, "utf8"), stopReason: authored.stopReason },
  );
}

/* -------------------------------------------------------------------------
 * The wiring
 * ---------------------------------------------------------------------- */

export interface AuthoringRepairDriverDeps {
  /** `createRepairDriver(...)`'s return value. The only thing that grades. */
  readonly driver: (request: SupervisorRepairRequest) => Promise<SupervisorRepairOutcome>;
  readonly runsDir: string;
  readonly proposalsDir: string;
  readonly journalDir: string;
  readonly repoRoot: string;
  readonly call: PatchAuthorCall;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly surveyTimeoutMs?: number;
  readonly authorTimeoutMs?: number;
}

/**
 * The repair driver, with an author in front of it.
 *
 * DRIVER-SHAPED IN, DRIVER-SHAPED OUT, so `supervisor-boot.ts` needs no edit and
 * its arm check still measures the driver it always measured. The composition
 * happens in `index.ts`, and only when `armRepairDriver` reported armed — an
 * unarmed grader means no authoring either, because a patch nothing can grade is
 * quota spent on a diff that can only sit there.
 *
 * THE DRIVER STILL DECIDES. Authoring runs first, its outcome is logged and
 * journalled, and then the driver runs regardless and its answer is returned
 * unchanged except for one appended sentence on the non-authored path. That
 * sentence is the point: without it a refusal to author arrives at the ticket as
 * the cycle's generic `NO_PATCH_AUTHOR` and the owner cannot tell "nobody wrote
 * one" from "one was attempted and refused, for this reason".
 */
export function createAuthoringRepairDriver(
  deps: AuthoringRepairDriverDeps,
): (request: SupervisorRepairRequest) => Promise<SupervisorRepairOutcome> {
  const log = deps.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  return async (request: SupervisorRepairRequest): Promise<SupervisorRepairOutcome> => {
    let authored: AuthorOutcome | null = null;
    if (request.runId !== null) {
      try {
        authored = await authorRepairPatch({
          defectPath: join(deps.runsDir, request.runId, "results", "defect.json"),
          proposalsDir: deps.proposalsDir,
          journalDir: deps.journalDir,
          repoRoot: deps.repoRoot,
          call: deps.call,
          runId: request.runId,
          // THE TICKET'S OWN CLOCK TRAVELS INTO THE AUTHOR. Without it the author
          // spends two model calls on a window the cycle will find closed.
          deadlineAt: request.deadlineAt,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.surveyTimeoutMs === undefined ? {} : { surveyTimeoutMs: deps.surveyTimeoutMs }),
          ...(deps.authorTimeoutMs === undefined ? {} : { authorTimeoutMs: deps.authorTimeoutMs }),
        });
      } catch (error) {
        /*
         * THE AUTHOR MAY NOT COST THE TICKET ITS CYCLE. `SupervisorLoop.#repair`
         * turns a thrown driver into `REPAIR_DRIVER_THREW` — one code for every
         * fault — and a throw from the author would report the GRADER as broken
         * when it has not run yet. So it becomes a named value and the driver
         * still runs.
         */
        authored = {
          kind: "inconclusive",
          code: "PATCH_AUTHOR_THREW",
          detail: `the patch author threw and no diff was written: ${error instanceof Error ? error.message : String(error)}`,
          diffPath: null,
          filesChanged: [],
          headSha: null,
          journalPath: null,
        };
      }
      log(`SUPERVISOR REPAIR AUTHOR: ${authored.kind} [${authored.code}] ${authored.detail}`);
    }

    const outcome = await deps.driver(request);
    if (authored === null || authored.kind === "authored") return outcome;
    const sentence = `A patch author ran first and produced no candidate diff: [${authored.code}] ${authored.detail}`;
    if (outcome.kind === "applied") return { ...outcome, detail: `${outcome.detail} ${sentence}` };
    if (outcome.kind === "refused") return { kind: "refused", code: outcome.code, detail: `${outcome.detail} ${sentence}` };
    return { kind: "inconclusive", code: outcome.code, detail: `${outcome.detail} ${sentence}` };
  };
}
