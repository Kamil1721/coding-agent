# Phase 2b — The DESIGN Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put real Gemini stills at the head of the pipeline — generated, manifested, locked, handed to the builders and to the visual gate — so that a run either builds to a chosen design or says loudly that it could not.

**Architecture:** The build phase becomes **two `builder.build()` calls against ONE session**. Segment 1 runs with `allowedAgents` narrowed to the SPEC and DESIGN lanes, so the measured `PreToolUse` delegation boundary — not model cooperation — is what stops BUILD starting before a design is locked. Between segments the run either parks at `awaiting_input` for the owner's click or auto-selects through `ui-designer`. Segment 2 resumes the same `session_id` with the locked mockup's absolute path injected into the build prompt.

**Tech Stack:** TypeScript 5.9.3, Node ≥24, `node:test`. `~/.claude/scripts/gemini-image.sh` (bash + curl + python3). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-orchestration-canvas-design.md` §7.1, §7.1a, §7.2, §7.3, §7.4, §7.5, §17 (§6.5 and §7.6.3 as constraints)

## A note on phase labels, so the next reader is not misled

The spec's own numbering drifted from what was built. **Spec §8 is headed "Phase 2b — Anti-slop enforcement" but that shipped TODAY as Phase 2a** (`docs/superpowers/plans/2026-07-29-phase-2a-antislop-hooks.md`). **Spec §7 is what is now called Phase 2b** and is what this plan implements. §12's implementation order uses the current labels; §8's heading does not. Where this plan says "2a" it means the anti-slop hooks that already exist in `dashboard/server/src/builders/antislop-*.ts`.

## Global Constraints

- `gemini-image.sh` default model is **`gemini-3.1-flash-image-preview` (Nano Banana 2)**. Never pin a different one from server code.
- Flags, verbatim: **`-a` aspect (`1:1 … 21:9`), `-o` output path, `-i reference.png`** — the style-consistency pass, "this is what holds the palette across the set, and why generation is strictly sequential".
- Key resolution order, verbatim: **`$GEMINI_API_KEY` → `$NANOBANANA_API_KEY` → `~/.gemini/api_key`**. `geminiKeyAvailable()` is a **server-side** check mirroring `gemini-image.sh:36-39`.
- Closed-loop critique per `taste-frontend-expert.md:46`: after each generation, Read the image and critique it against the routed skill's rules; regenerate weak images with a corrected prompt, **max 2 retries**, using `-i` with the best sibling.
- **≥5 PNGs land in `design-refs/` inside the workspace** with a `manifest.json` mapping **absolute path → section, aspect, intent**.
- The DESIGN→BUILD handoff is **three mechanisms, all required**: filesystem, prompt injection of **absolute image paths**, and the `image-to-code` skill bridge. Two of three is nothing.
- The three dials are injected **verbatim**: `DESIGN_VARIANCE` / `MOTION_INTENSITY` / `VISUAL_DENSITY`.
- The visual gate is **`ui-designer`, deliberately not the mockup author**, writing `review/visual-gate.md` at **QUALITY tier, non-blocking**.
- `designLane = surface ∈ {web-ui, fullstack} && (visualIntent(ticket) || surface === "web-ui") && geminiKeyAvailable()`. **If false because no key resolves, DESIGN degrades — it does not block.**
- **Until 2c lands the Layer-2 gate must not demand video.** The satisfier list is gated on a capability flag derived from whether `gemini-video.sh` is present and a key resolves.
- **`costUsd: null` is a system-wide invariant for subscription runs.** Design-lane spend is tracked on its own line; `costUsd` stays `null` for build/gate/judge.
- **Never echo the key** into a prompt, a log line, a canvas node, a file or a commit. `GEMINI_API_KEY`/`NANOBANANA_API_KEY` are deliberately **absent** from `STRIPPED_ENV_NAMES` (`subprocess-env.ts:39-55`, verified by reading it) so they survive env-stripping. That is intended, and it is the reason the never-echo rule is a constraint rather than a nicety.
- **`DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN`** bounds the park. `designLock: "auto" | "ask"` on `POST /api/runs`, **defaulting to `auto` when the request is not interactive**. The auto-chooser is **`ui-designer`, not `taste-frontend-expert`**. The choice is **recorded either way**, with who made it and why, and a locked design **is an input to the gate**, so it is recorded in the run record alongside the ticket.
- **`ApiPhase` is NOT widened.** There is no `design` phase. The DESIGN lane is a *lane*, and both segments run inside the existing `build` phase. Widening `ApiPhase` would mean a three-site contract change plus new persisted values for zero gain.
- Never modify `bakeoff/`. No AI-attribution trailer. No `git push`. No `git commit --amend`.

---

## THE TRAP — read this before writing any code

**A DESIGN lane that produced zero images must never look successful.**

`sandbox.autoAllowBashIfSandboxed: true` (`claude-builder.ts:1011`) means **Bash never reaches `decideToolPermission`**. Every failure in the image chain therefore surfaces as a script error on a stream the permission layer cannot see:

```
missing python3            gemini-image.sh dies at :48   → no PNG, exit 1
npx impeccable unresolvable the skill's setup step fails  → no PNG, no error the host sees
TMPDIR outside allowWrite  mktemp -d at :43 writes outside [workspace] → no PNG
no key resolves            dies at :40                   → no PNG
all models 4xx             dies after the fallback chain → no PNG
```

Every one of those produces **the identical observable**: a lane that ran, wrote nothing, and reported no error. The orchestrator sees a completed build, the gate grades a page with no reference, `lockedMockup` is `null`, `visualCriteriaFor` quietly falls back to the rule-based floor — and the run is reported as a success with a degraded gate nobody was told about.

**The rule, and it is not negotiable:**

```
DESIGN lane mode      images   verdict
────────────────────────────────────────────────────────────────────────
"full"                 ≥5      normal
"full"                 1-4     LOUD — designFailure = "too-few-images"
"full"                  0      LOUD — designFailure = "no-images"
"degraded"              0      EXPECTED — recorded as degraded, with the reason
"off"                   0      not a design run; nothing is claimed
```

`"degraded"` and `"full"-with-zero` produce the same file count and **must never produce the same report**. The difference is decided *before* the lane runs — by `detectDesignCapability` — and is written down at that moment, so a zero-image lane can always be told apart from a lane that was never going to produce images.

Task 7 owns this, and it is the one task whose negative control is mandatory rather than advisory: run the lane with the image script deliberately broken and assert the run says so.

---

## File Structure

| Path | Responsibility |
|---|---|
| `dashboard/server/src/design-manifest.ts` | **new.** The single declaration site for `DesignManifest`, `DesignRef`, `DesignLock`; parse/serialise/validate; `toVisualManifest`. Widened by 2c without a breaking change. |
| `dashboard/server/src/design-manifest.test.ts` | **new.** Round-trip, path containment, forward-compat, `DesignLock` conformance. |
| `dashboard/server/src/design-capability.ts` | **new.** `geminiKeyAvailable` (mirrors `gemini-image.sh:36-39`), `detectDesignCapability`, `designPreflight` — §7.5's risk table as executable assertions. |
| `dashboard/server/src/design-capability.test.ts` | **new.** Every risk row, each with a negative control. |
| `dashboard/server/src/design-env.ts` | **new.** `designSubprocessEnv` — `TMPDIR` inside the workspace, the motion-bar flip, and the proof the two Gemini key names survive stripping. |
| `dashboard/server/src/design-env.test.ts` | **new.** Includes the executed `mktemp -d` proof. |
| `dashboard/server/src/design-lane.ts` | **new.** `visualIntent`, `designLaneMode` — §6.5's predicate, three-state so "degrade" is not "off". |
| `dashboard/server/src/design-lane.test.ts` | **new.** |
| `dashboard/server/src/design-prompt.ts` | **new.** The DESIGN segment prompt, the DESIGN→BUILD handoff block (all three mechanisms), the visual-gate prompt. |
| `dashboard/server/src/design-prompt.test.ts` | **new.** One test per handoff mechanism, each independently red-able. |
| `dashboard/server/src/design-outcome.ts` | **new.** THE TRAP. `classifyDesignLane`, `designLaneFailureMessage`, the `results/design-lane.json` record and its call-count line. |
| `dashboard/server/src/design-outcome.test.ts` | **new.** |
| `dashboard/server/src/design-lock.ts` | **new.** `designLockPolicy`, `designLockTimeoutMin`, `designLockExpired`, `lockManifest`, `readDesignLock`/`writeDesignLock`. |
| `dashboard/server/src/design-lock.test.ts` | **new.** |
| `dashboard/server/src/build-segment.ts` | **new.** `nextBuildSegment`, `graphResumeState`, `makeSegmentRemap` — the two-segment plumbing and the node-id collision fix. |
| `dashboard/server/src/build-segment.test.ts` | **new.** |
| `dashboard/server/src/design-segment-probe.mjs` | **new.** The live arm: does segment 2 actually resume segment 1's `session_id`? |
| `dashboard/server/src/visual-criteria.ts:58-68` | **modify.** `DesignManifest` moves to `design-manifest.ts`; this file imports and re-exports it and narrows `visualCriteriaFor`'s parameter to `DesignLock`. One declaration site, as its own docblock demands. |
| `dashboard/server/src/visual-criteria.test.ts:24-30` | **modify.** One annotation changes from `DesignManifest` to `DesignLock`; every assertion is untouched. |
| `dashboard/server/src/agent-shortlist.ts:92-99` | **modify.** `designLaneRuns` keeps the DESIGN agents shortlisted in `degraded` mode — the lane degrades, it does not vanish. |
| `dashboard/server/src/api-types.ts` | **modify.** `CreateRunRequest.designLock`, `RunDetail.designLock: ApiDesignLock | null`. |
| `dashboard/src/lib/api-types.ts` | **modify.** The client mirror of both, in the same commit. Nothing compares `RunDetail` across the two packages — forgetting this compiles clean on both sides. |
| `dashboard/server/src/http.ts` | **modify.** `designLock` on `POST /api/runs`; `{chosenMockup}` body on `POST /api/runs/:id/resume`; `designLock` in `toDetail`. |
| `dashboard/server/src/orchestrator.ts` | **modify.** `#buildPhase` becomes two segments; `#parkForDesignLock`; `resume(runId, chosenMockup)`; mockups registered as screenshots. |
| `dashboard/server/src/builders/claude-builder.ts` | **modify.** Nothing structural — only `buildOptions` gaining the `sandbox.network` absence assertion's counterpart comment. Registration of hooks is unchanged. |

**Run every command from `dashboard/server`.** Four other agents are editing this tree; compile to a private outDir so a sibling's `npm test` and yours do not clobber one another's `dist/`:

```bash
npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"
```

**The outDir name is not free-form.** `contract-parity.test.ts` resolves the client package as `join(import.meta.dirname, "..", "..", "src", "lib")` and says so explicitly: *"`import.meta.dirname` is `dashboard/server/<outDir>` at run time… Every outDir this repo uses sits at that same depth for exactly this reason."* `dashboard/server/dist-2b` is at that depth. A nested outDir would make that test fail — and it fails rather than skips, deliberately.

---

### Task 1: The manifest — one declaration site, widened for 2c

**Why first:** every later task reads or writes this shape. `visual-criteria.ts:58-68` says in its own docblock that *"Phase 2b (DESIGN lane) owns the full manifest and will widen this"* and that *"a second declaration site for a type Phase 2b owns is a merge conflict with a wrong answer in it"* — so the type **moves** here rather than being copied.

**The constraint that decides the design:** `calibration/grade-fixture.ts:212` calls `visualCriteriaFor({ lockedMockup: null })` with a bare object literal. Adding required fields to the type that function takes breaks that call site — and `calibration/` is another agent's directory. So `visualCriteriaFor` narrows to the shape it actually reads (`DesignLock`), and the widened `DesignManifest` extends it.

**Files:**
- Create: `dashboard/server/src/design-manifest.ts`
- Create: `dashboard/server/src/design-manifest.test.ts`
- Modify: `dashboard/server/src/visual-criteria.ts:58-68` and `:208`
- Modify: `dashboard/server/src/visual-criteria.test.ts:24-30`

**Interfaces:**
- Produces:
```ts
export const DESIGN_REFS_DIR = "design-refs";
export const DESIGN_MANIFEST_FILE = "manifest.json";
export type DesignAspect = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
export const DESIGN_ASPECTS: readonly DesignAspect[];
export type DesignLockedBy = "owner" | "ui-designer" | "fallback";
export interface DesignRef {
  readonly path: string;        // ABSOLUTE, inside <workspace>/design-refs/
  readonly section: string;
  readonly aspect: DesignAspect;
  readonly intent: string;
  readonly animate?: boolean;   // 2c writes it; absent means "2b did not consider it"
}
export interface DesignLock { readonly lockedMockup: string | null; }
export interface DesignManifest extends DesignLock {
  readonly version: 1;
  readonly refs: readonly DesignRef[];
  readonly lockedMockup: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly lockedReason: string | null;
  readonly lockedAt: string | null;
}
export function manifestPathFor(workspace: string): string;
export function refsDirFor(workspace: string): string;
export function emptyManifest(): DesignManifest;
export function parseDesignManifest(text: string, workspace: string): DesignManifest | null;
export function serialiseDesignManifest(manifest: DesignManifest): string;
export function toVisualManifest(manifest: DesignManifest): DesignLock;
/** Disk-facing helpers. Every later task reads the manifest through these two. */
export function readDesignManifest(workspace: string): DesignManifest | null;
/** Drop refs whose file is not on disk. What the HANDOFF is built from. */
export function pruneMissingRefs(manifest: DesignManifest): DesignManifest;
export function writeDesignManifest(workspace: string, manifest: DesignManifest): void;
export function readDesignDirection(workspace: string): string;
export function countDesignPngs(refsDir: string): number;
```

**The on-disk key is `locked`; the in-memory field is `lockedMockup`.** §17.1 states the file *"gains `\"locked\": \"<path>\"`"*, and `visual-criteria.ts` already reads `lockedMockup`. Both are honoured by the parse/serialise pair rather than by renaming either.

**Forward-compat rule for 2c, stated so it is not rediscovered:** `animate?: boolean` and any future additive optional field **do not bump `version`**. `version` moves only when the *absence* of a field changes the meaning of a file that omits it. §7.6.3 says 2c adds `animate: boolean` and `aspect`; `aspect` is already required here because §7.2 lists it in the 2b shape, so 2c adds exactly one optional field and widens nothing else.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design-manifest.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DESIGN_MANIFEST_FILE,
  emptyManifest,
  manifestPathFor,
  parseDesignManifest,
  serialiseDesignManifest,
  toVisualManifest,
  type DesignLock,
  type DesignManifest,
} from "./design-manifest.js";

const WS = "/runs/r1/workspace";
const REF = `${WS}/design-refs/01-hero.png`;

function refJson(path = REF): string {
  return JSON.stringify({
    version: 1,
    refs: [{ path, section: "hero", aspect: "16:9", intent: "full-bleed opening statement" }],
  });
}

test("the manifest maps ABSOLUTE path -> section, aspect, intent (spec §7.2)", () => {
  const m = parseDesignManifest(refJson(), WS);
  assert.ok(m !== null);
  assert.equal(m.refs[0]?.path, REF);
  assert.equal(m.refs[0]?.section, "hero");
  assert.equal(m.refs[0]?.aspect, "16:9");
  assert.equal(m.refs[0]?.intent, "full-bleed opening statement");
});

test("a ref outside <workspace>/design-refs/ is REFUSED, not trusted", () => {
  // The manifest is written by an AGENT inside the workspace. A path it invents
  // becomes a `Read` target injected into every build prompt (§7.3 mechanism 2)
  // and, once locked, the reference the visual gate grades against. An absolute
  // path pointing at ~/.gemini/api_key would be read out loud into a prompt.
  assert.equal(parseDesignManifest(refJson("/etc/passwd"), WS), null);
  assert.equal(parseDesignManifest(refJson(`${WS}/../elsewhere/x.png`), WS), null);
  assert.equal(parseDesignManifest(refJson("design-refs/01-hero.png"), WS), null, "relative is refused too");
});

test("an unknown aspect is refused — gemini-image.sh accepts 1:1 … 21:9 and nothing else", () => {
  const bad = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "17:11", intent: "x" }],
  });
  assert.equal(parseDesignManifest(bad, WS), null);
});

test("the on-disk key is `locked` (§17.1) and the in-memory field is `lockedMockup`", () => {
  const withLock = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x" }],
    locked: REF,
    lockedBy: "owner",
    lockedReason: "chosen in the dashboard",
    lockedAt: "2026-07-29T10:00:00.000Z",
  });
  const m = parseDesignManifest(withLock, WS);
  assert.equal(m?.lockedMockup, REF);
  assert.equal(m?.lockedBy, "owner");
  assert.match(serialiseDesignManifest(m as DesignManifest), /"locked":/);
  assert.doesNotMatch(serialiseDesignManifest(m as DesignManifest), /"lockedMockup":/);
});

test("a `locked` path that is not one of the refs is dropped to null, loudly typed", () => {
  // An agent that writes its own favourite path into `locked` must not be able to
  // point the gate at a file nobody generated.
  const forged = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x" }],
    locked: `${WS}/design-refs/99-invented.png`,
  });
  assert.equal(parseDesignManifest(forged, WS)?.lockedMockup, null);
});

test("2c widens without a breaking change: an unknown-but-optional field parses", () => {
  // §7.6.3 adds `animate: boolean`. A 2b reader must accept a 2c file, and a 2c
  // reader must accept a 2b file, with NO version bump — that is the contract.
  const from2c = JSON.stringify({
    version: 1,
    refs: [{ path: REF, section: "hero", aspect: "16:9", intent: "x", animate: true }],
  });
  assert.equal(parseDesignManifest(from2c, WS)?.refs[0]?.animate, true);
  assert.equal(parseDesignManifest(refJson(), WS)?.refs[0]?.animate, undefined, "absent, never invented as false");
});

test("a DesignManifest satisfies DesignLock structurally — the visual gate reads only that", () => {
  const lock: DesignLock = toVisualManifest(emptyManifest());
  assert.equal(lock.lockedMockup, null);
});

test("manifestPathFor names the file the DESIGN lane is told to write", () => {
  assert.equal(manifestPathFor(WS), `${WS}/design-refs/${DESIGN_MANIFEST_FILE}`);
});

test("garbage is null, never a partial manifest", () => {
  assert.equal(parseDesignManifest("not json", WS), null);
  assert.equal(parseDesignManifest("{}", WS), null);
  assert.equal(parseDesignManifest(JSON.stringify({ version: 2, refs: [] }), WS), null);
});

test("the disk helpers round-trip, and a missing file is null rather than a throw", () => {
  const ws = mkdtempSync(join(tmpdir(), "design-ws-"));
  assert.equal(readDesignManifest(ws), null, "no manifest yet — null, not an exception");
  const png = join(ws, "design-refs", "01-hero.png");
  mkdirSync(join(ws, "design-refs"), { recursive: true });
  writeFileSync(png, "not really a png", "utf8");
  const manifest: DesignManifest = {
    version: 1,
    refs: [{ path: png, section: "hero", aspect: "16:9", intent: "x" }],
    lockedMockup: null, lockedBy: null, lockedReason: null, lockedAt: null,
  };
  writeDesignManifest(ws, manifest);
  assert.deepEqual(readDesignManifest(ws), manifest);
  assert.equal(readDesignDirection(ws), "", "absent direction is empty, never a heading over a hole");
});

test("pruneMissingRefs keeps the prompt honest, and drops a lock that points at nothing", () => {
  // A partial lane does not stop the run, so the build segment still gets a
  // handoff — but a path in a prompt that resolves to nothing is a Read failure
  // several turns deep inside a build agent, reported as its confusion rather
  // than as a design fault.
  const ws = mkdtempSync(join(tmpdir(), "design-prune-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(refsDir, { recursive: true });
  const present = join(refsDir, "01.png");
  const absent = join(refsDir, "02.png");
  writeFileSync(present, "x", "utf8");
  const manifest: DesignManifest = {
    version: 1,
    refs: [
      { path: present, section: "hero", aspect: "16:9", intent: "x" },
      { path: absent, section: "work", aspect: "16:9", intent: "y" },
    ],
    lockedMockup: absent, lockedBy: "owner", lockedReason: "r", lockedAt: "2026-07-29T10:00:00.000Z",
  };
  const pruned = pruneMissingRefs(manifest);
  assert.deepEqual(pruned.refs.map((r) => r.path), [present]);
  assert.equal(pruned.lockedMockup, null, "a lock on a missing file is no lock");
  assert.equal(pruned.lockedBy, null);
  assert.equal(pruneMissingRefs({ ...manifest, refs: [manifest.refs[0]!], lockedMockup: present }).lockedMockup, present);
});

test("countDesignPngs counts DISK, not the manifest's claims", () => {
  // classifyDesignLane compares the two. A count taken from the manifest would
  // make "the manifest lists 5 refs over 3 files" undetectable by construction.
  const ws = mkdtempSync(join(tmpdir(), "design-count-"));
  const refsDir = join(ws, "design-refs");
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, "01.png"), "x", "utf8");
  writeFileSync(join(refsDir, "02.PNG"), "x", "utf8");
  writeFileSync(join(refsDir, "manifest.json"), "{}", "utf8");
  assert.equal(countDesignPngs(refsDir), 2);
  assert.equal(countDesignPngs(join(ws, "nope")), 0);
});
```

The test file's imports grow accordingly: `import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";` and the five new helpers (`readDesignManifest`, `writeDesignManifest`, `readDesignDirection`, `countDesignPngs`, `pruneMissingRefs`) from `./design-manifest.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './design-manifest.js' or its corresponding type declarations.`

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design-manifest.ts
/**
 * design-manifest.ts — the DESIGN lane's contract with everything downstream.
 *
 * THE SINGLE DECLARATION SITE. `visual-criteria.ts` carried a deliberately
 * minimal `DesignManifest` with a docblock saying Phase 2b owns the full one and
 * that a second declaration site "is a merge conflict with a wrong answer in it".
 * This is that file; visual-criteria.ts now imports from here.
 *
 * IT IS WRITTEN BY AN AGENT AND READ BY THE HOST, so every field is validated on
 * the way in. `refs[].path` becomes a `Read` target injected verbatim into every
 * build agent's prompt (spec §7.3) and, once locked, the image the visual gate
 * grades against (spec §7.4). An unvalidated absolute path there is a file-read
 * primitive with a prompt attached.
 *
 * TWO SPELLINGS OF ONE FIELD, ON PURPOSE. Spec §17.1 says the file "gains
 * `"locked": "<path>"`" and `visual-criteria.ts` already reads `lockedMockup`.
 * The disk key is `locked`; the parsed field is `lockedMockup`. Renaming either
 * would contradict something that is already written down.
 *
 * FORWARD COMPATIBILITY WITH 2c, WHICH IS A RULE AND NOT A HOPE. Spec §7.6.3
 * adds `animate: boolean` to a ref. Additive OPTIONAL fields do not bump
 * `version`; `version` moves only when the ABSENCE of a field would change the
 * meaning of a file that omits it. `aspect` is required here already because
 * §7.2 puts it in the 2b shape, so 2c's widening is exactly one optional field.
 */

import { isAbsolute, join, relative } from "node:path";

export const DESIGN_REFS_DIR = "design-refs";
export const DESIGN_MANIFEST_FILE = "manifest.json";

/** Exactly `gemini-image.sh`'s `-a` set, read off the script rather than recalled. */
export type DesignAspect = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
export const DESIGN_ASPECTS: readonly DesignAspect[] = Object.freeze([
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
]);

/**
 * Who chose the locked mockup.
 *
 * `"fallback"` is NOT in spec §17.3 and is deliberately added: rule 3 names
 * `ui-designer` as the auto-chooser, and rule 4 says the choice is recorded
 * either way — so the case where `ui-designer` produced no usable choice needs a
 * name of its own. Recording it as `"ui-designer"` would be a lie about
 * provenance; recording nothing would make an unattended run unexplainable.
 */
export type DesignLockedBy = "owner" | "ui-designer" | "fallback";

export interface DesignRef {
  /** ABSOLUTE, and inside `<workspace>/design-refs/`. Both are enforced on parse. */
  readonly path: string;
  readonly section: string;
  readonly aspect: DesignAspect;
  readonly intent: string;
  /** Phase 2c. Absent means 2b never considered it — never `false` by invention. */
  readonly animate?: boolean;
}

/**
 * What the visual gate reads, and the ONLY thing it reads.
 *
 * `visualCriteriaFor` takes this rather than the whole manifest so that
 * `calibration/grade-fixture.ts:212`'s `visualCriteriaFor({ lockedMockup: null })`
 * keeps compiling while this file grows.
 */
export interface DesignLock {
  readonly lockedMockup: string | null;
}

export interface DesignManifest extends DesignLock {
  readonly version: 1;
  readonly refs: readonly DesignRef[];
  readonly lockedMockup: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly lockedReason: string | null;
  readonly lockedAt: string | null;
}

export function refsDirFor(workspace: string): string {
  return join(workspace, DESIGN_REFS_DIR);
}

export function manifestPathFor(workspace: string): string {
  return join(refsDirFor(workspace), DESIGN_MANIFEST_FILE);
}

export function emptyManifest(): DesignManifest {
  return { version: 1, refs: [], lockedMockup: null, lockedBy: null, lockedReason: null, lockedAt: null };
}

/** Inside `dir`, or `dir` itself. Not a permission check — a validation one. */
function insideDir(candidate: string, dir: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(dir, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRef(raw: unknown, refsDir: string): DesignRef | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const path = readString(record["path"]);
  const section = readString(record["section"]);
  const intent = readString(record["intent"]);
  const aspect = record["aspect"];
  if (path === null || section === null || intent === null) return null;
  if (!insideDir(path, refsDir)) return null;
  if (typeof aspect !== "string" || !DESIGN_ASPECTS.includes(aspect as DesignAspect)) return null;
  const animate = record["animate"];
  return {
    path,
    section,
    aspect: aspect as DesignAspect,
    intent,
    ...(typeof animate === "boolean" ? { animate } : {}),
  };
}

function readLockedBy(value: unknown): DesignLockedBy | null {
  return value === "owner" || value === "ui-designer" || value === "fallback" ? value : null;
}

/**
 * Parse and VALIDATE. Null means "there is no usable manifest" — never a partial
 * one, because a partial manifest is what turns a degraded lane into a silent one.
 */
export function parseDesignManifest(text: string, workspace: string): DesignManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== 1) return null;
  const rawRefs = record["refs"];
  if (!Array.isArray(rawRefs)) return null;

  const refsDir = refsDirFor(workspace);
  const refs: DesignRef[] = [];
  for (const entry of rawRefs) {
    const ref = readRef(entry, refsDir);
    if (ref === null) return null;
    refs.push(ref);
  }

  // A `locked` path the agent invented points the gate at a file nobody
  // generated. It is dropped rather than honoured, and dropping it is visible:
  // `lockedMockup: null` is exactly the degraded state visual-criteria.ts grades.
  const claimed = readString(record["locked"]);
  const locked = claimed !== null && refs.some((ref) => ref.path === claimed) ? claimed : null;

  return {
    version: 1,
    refs,
    lockedMockup: locked,
    lockedBy: locked === null ? null : readLockedBy(record["lockedBy"]),
    lockedReason: locked === null ? null : readString(record["lockedReason"]),
    lockedAt: locked === null ? null : readString(record["lockedAt"]),
  };
}

export function serialiseDesignManifest(manifest: DesignManifest): string {
  return `${JSON.stringify(
    {
      version: manifest.version,
      refs: manifest.refs,
      locked: manifest.lockedMockup,
      lockedBy: manifest.lockedBy,
      lockedReason: manifest.lockedReason,
      lockedAt: manifest.lockedAt,
    },
    null,
    2,
  )}\n`;
}

/** The projection the visual gate takes. Nothing else crosses that seam. */
export function toVisualManifest(manifest: DesignManifest): DesignLock {
  return { lockedMockup: manifest.lockedMockup };
}

/* ---- disk ------------------------------------------------------------- */

/**
 * ONE READ PATH FOR THE WHOLE PHASE. Every consumer — the segment chooser, the
 * handoff, the lock, the visual gate — goes through this, so the validation
 * above cannot be bypassed by a caller that reads the file itself.
 */
export function readDesignManifest(workspace: string): DesignManifest | null {
  const path = manifestPathFor(workspace);
  if (!existsSync(path)) return null;
  try {
    return parseDesignManifest(readFileSync(path, "utf8"), workspace);
  } catch {
    return null;
  }
}

/**
 * The manifest with every ref whose file is missing removed.
 *
 * WHAT THE HANDOFF IS BUILT FROM, AND WHY IT IS A SEPARATE FUNCTION. A partial
 * DESIGN lane (`too-few-images`, `manifest-invalid`) does NOT stop the run —
 * degrade-don't-block applies here as everywhere else — so the build segment
 * still gets a handoff. But §7.3 mechanism 2 works by putting absolute paths in
 * a prompt, and a path that resolves to nothing is a `Read` failure inside every
 * build agent, several turns deep, reported as an agent's confusion rather than
 * as a design fault. So the REPORT keeps the discrepancy (`classifyDesignLane`
 * compares the manifest's claim against the disk count) and the PROMPT carries
 * only files that exist.
 *
 * A locked mockup that is itself missing drops the lock: the gate then grades on
 * the rule-based floor, which is the honest answer, rather than against a
 * reference nobody can open.
 */
export function pruneMissingRefs(manifest: DesignManifest): DesignManifest {
  const refs = manifest.refs.filter((ref) => existsSync(ref.path));
  if (refs.length === manifest.refs.length) return manifest;
  const lockedSurvives = manifest.lockedMockup !== null && refs.some((r) => r.path === manifest.lockedMockup);
  return {
    ...manifest,
    refs,
    lockedMockup: lockedSurvives ? manifest.lockedMockup : null,
    lockedBy: lockedSurvives ? manifest.lockedBy : null,
    lockedReason: lockedSurvives ? manifest.lockedReason : null,
    lockedAt: lockedSurvives ? manifest.lockedAt : null,
  };
}

/** Used only by the HOST, when it applies a lock. The agent writes the refs. */
export function writeDesignManifest(workspace: string, manifest: DesignManifest): void {
  mkdirSync(refsDirFor(workspace), { recursive: true });
  writeFileSync(manifestPathFor(workspace), serialiseDesignManifest(manifest), "utf8");
}

/**
 * The written art direction. Empty string when absent — the handoff renders
 * nothing rather than a heading over a hole.
 */
export function readDesignDirection(workspace: string): string {
  const path = join(refsDirFor(workspace), "direction.md");
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * How many stills actually exist.
 *
 * COUNTED FROM DISK, NEVER FROM THE MANIFEST, and that is the whole point: the
 * manifest is a claim an agent wrote, and `classifyDesignLane` compares the two
 * to catch a manifest that lists five refs over three files.
 */
export function countDesignPngs(refsDir: string): number {
  if (!existsSync(refsDir)) return 0;
  try {
    return readdirSync(refsDir).filter((name) => name.toLowerCase().endsWith(".png")).length;
  } catch {
    return 0;
  }
}
```

The imports this file needs: `import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";` and `import { isAbsolute, join, relative } from "node:path";`.

Then move the declaration out of `visual-criteria.ts`. Replace lines 58-68 with:

```ts
/**
 * MOVED TO `design-manifest.ts` ON 2026-07-29 (Phase 2b), which is what the
 * previous docblock here asked for: "Phase 2b (DESIGN lane) owns the full
 * manifest and will widen this... a second declaration site for a type Phase 2b
 * owns is a merge conflict with a wrong answer in it." Re-exported so existing
 * importers do not move.
 */
export type { DesignLock, DesignManifest } from "./design-manifest.js";
```

and change the signature at `:208` to read the shape it actually uses:

```ts
export function visualCriteriaFor(manifest: DesignLock): readonly VisualCriterion[] {
```

with `import type { DesignLock } from "./design-manifest.js";` at the top. **`grade-fixture.ts:212`'s `visualCriteriaFor({ lockedMockup: null })` keeps compiling unchanged, and that is the whole reason for the narrowing.**

In `visual-criteria.test.ts`, exactly one annotation changes (lines 24-30):

```ts
import type { DesignLock } from "./visual-criteria.js";
import { visualCriteriaFor } from "./visual-criteria.js";

/** The DESIGN lane's happy path: the owner clicked a mockup and it was recorded. */
function manifestWithLock(lockedMockup = "/ws/design-refs/02-hero.png"): DesignLock {
  return { lockedMockup };
}
```

Every assertion in that file is untouched.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS — including the five pre-existing tests in `visual-criteria.test.js` and `calibration/grade-fixture` still compiling.

- [ ] **Step 5: Negative control — prove the path guard can go red**

Temporarily delete the `if (!insideDir(path, refsDir)) return null;` line and re-run.
Expected: FAIL with `a ref outside <workspace>/design-refs/ is REFUSED, not trusted`. Restore the line and re-run to green.

Then temporarily change `record["version"] !== 1` to `false` and re-run.
Expected: FAIL with `garbage is null, never a partial manifest`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-manifest.ts dashboard/server/src/design-manifest.test.ts dashboard/server/src/visual-criteria.ts dashboard/server/src/visual-criteria.test.ts <<'MSG'
feat(design): the DESIGN lane manifest, with one declaration site

visual-criteria.ts's DesignManifest was minimal by design and its docblock said
Phase 2b owns the full one. It moves here rather than being copied, and
visualCriteriaFor narrows to the DesignLock shape it actually reads so
calibration/grade-fixture.ts's bare `{ lockedMockup: null }` literal still
compiles.

refs[].path is validated as absolute and inside <workspace>/design-refs/: it
becomes a Read target injected verbatim into every build prompt, so an
unvalidated path there is a file-read primitive with a prompt attached. A
`locked` value that names no ref is dropped to null, which is exactly the
degraded state the visual gate already grades.
MSG
```

---

### Task 2: Capability and preflight — §7.5's risk table as executable assertions

**Why this task exists:** §7.5 lists five ways the image chain breaks and one reason none of them is visible. Every row becomes an assertion here, checked **before** the lane runs, so a failure is a named preflight result rather than a silent absence of PNGs.

**Files:**
- Create: `dashboard/server/src/design-capability.ts`
- Create: `dashboard/server/src/design-capability.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
```ts
export const GEMINI_IMAGE_SCRIPT = "~/.claude/scripts/gemini-image.sh";
export const GEMINI_VIDEO_SCRIPT = "~/.claude/scripts/gemini-video.sh";
export type GeminiKeySource = "GEMINI_API_KEY" | "NANOBANANA_API_KEY" | "~/.gemini/api_key";
export interface GeminiKeyResolution {
  readonly available: boolean;
  readonly source: GeminiKeySource | null;   // WHICH one, never the value
}
export function geminiKeyAvailable(env: NodeJS.ProcessEnv, homeDir: string): GeminiKeyResolution;
export interface DesignCapability {
  readonly imageScript: string | null;
  readonly key: GeminiKeyResolution;
  /** §7.1a — `gemini-video.sh` present AND a key resolves. False through 2b. */
  readonly video: boolean;
}
export function detectDesignCapability(opts: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  imageScript?: string;
  videoScript?: string;
}): DesignCapability;
export interface PreflightCheck {
  readonly id: "python3" | "npx-impeccable" | "image-script" | "gemini-key" | "tmpdir";
  readonly ok: boolean;
  readonly blocking: boolean;
  readonly detail: string;
}
export interface DesignPreflight {
  readonly checks: readonly PreflightCheck[];
  readonly ok: boolean;                       // no BLOCKING check failed
  readonly blockers: readonly string[];
}
export type CommandRunner = (command: string, args: readonly string[]) => Promise<{ code: number; stderr: string }>;
/** The real runner and the real writability probe, for the orchestrator to pass in. */
export const execCommandRunner: CommandRunner;
export function canWriteDir(dir: string): boolean;
export function designPreflight(opts: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  workspace: string;
  capability: DesignCapability;
  run: CommandRunner;
  canWrite: (dir: string) => boolean;
}): Promise<DesignPreflight>;
```

**Two judgement calls, stated rather than buried.** `python3`, the image script and the key are **blocking** — without any of them not one PNG can exist. `npx impeccable` and `TMPDIR` are **non-blocking but recorded**: `impeccable`'s absence degrades one skill rather than the lane, and a `TMPDIR` that cannot be created is reported so the operator sees it, while Task 3 is what actually sets the variable. §7.5 says "assert resolvable"; it does not say "block", and blocking a design run on a registry fetch would be a new failure mode invented here.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design-capability.test.ts
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  designPreflight,
  detectDesignCapability,
  geminiKeyAvailable,
  type CommandRunner,
} from "./design-capability.js";

function homeWithKeyFile(): string {
  const home = mkdtempSync(join(tmpdir(), "design-home-"));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "api_key"), "  sk-not-a-real-key\n", "utf8");
  return home;
}

const ok: CommandRunner = async () => ({ code: 0, stderr: "" });
const fails: CommandRunner = async () => ({ code: 127, stderr: "command not found" });

test("key resolution order is gemini-image.sh:36-39, VERBATIM", () => {
  const home = homeWithKeyFile();
  assert.equal(
    geminiKeyAvailable({ GEMINI_API_KEY: "a", NANOBANANA_API_KEY: "b" }, home).source,
    "GEMINI_API_KEY",
  );
  assert.equal(geminiKeyAvailable({ NANOBANANA_API_KEY: "b" }, home).source, "NANOBANANA_API_KEY");
  assert.equal(geminiKeyAvailable({}, home).source, "~/.gemini/api_key");
});

test("NO key anywhere resolves to unavailable — this is the degrade trigger, not an error", () => {
  const bare = mkdtempSync(join(tmpdir(), "design-home-empty-"));
  const resolution = geminiKeyAvailable({}, bare);
  assert.equal(resolution.available, false);
  assert.equal(resolution.source, null);
});

test("an EMPTY key file does not count as a key", () => {
  // `tr -d '[:space:]'` on a whitespace-only file yields "", and the script's
  // `[ -n "$KEY" ]` then dies at :40. A server-side check that said "available"
  // here would send the lane at a script guaranteed to fail.
  const home = mkdtempSync(join(tmpdir(), "design-home-blank-"));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "api_key"), "   \n\n", "utf8");
  assert.equal(geminiKeyAvailable({}, home).available, false);
});

test("the resolution NEVER carries the key value — only which source won", () => {
  // CLAUDE.md:18 and spec §7.5: never echo the key into a prompt, log or node.
  // The tightest way to keep that true is for the value never to leave this file.
  const home = homeWithKeyFile();
  const json = JSON.stringify(geminiKeyAvailable({ GEMINI_API_KEY: "sk-live-SECRET" }, home));
  assert.doesNotMatch(json, /sk-live-SECRET/);
  assert.doesNotMatch(json, /sk-not-a-real-key/);
});

test("video capability is FALSE while gemini-video.sh does not exist (§7.1a)", () => {
  const home = homeWithKeyFile();
  const capability = detectDesignCapability({
    env: {},
    homeDir: home,
    imageScript: join(home, "gemini-image.sh"),
    videoScript: join(home, "gemini-video.sh"),
  });
  assert.equal(capability.video, false, "2c has not landed; nothing may demand video");
});

test("video capability requires BOTH the script and a key", () => {
  const home = homeWithKeyFile();
  const videoScript = join(home, "gemini-video.sh");
  writeFileSync(videoScript, "#!/usr/bin/env bash\n", "utf8");
  const imageScript = join(home, "gemini-image.sh");
  writeFileSync(imageScript, "#!/usr/bin/env bash\n", "utf8");
  assert.equal(detectDesignCapability({ env: {}, homeDir: home, imageScript, videoScript }).video, true);

  const noKeyHome = mkdtempSync(join(tmpdir(), "design-home-nokey-"));
  assert.equal(
    detectDesignCapability({ env: {}, homeDir: noKeyHome, imageScript, videoScript }).video,
    false,
    "a script with no key generates nothing",
  );
});

test("preflight BLOCKS on a missing python3 — gemini-image.sh uses it twice (:48, :97)", async () => {
  const home = homeWithKeyFile();
  const script = join(home, "gemini-image.sh");
  writeFileSync(script, "#!/usr/bin/env bash\n", "utf8");
  const result = await designPreflight({
    env: {},
    homeDir: home,
    workspace: home,
    capability: detectDesignCapability({ env: {}, homeDir: home, imageScript: script }),
    run: async (command) => (command === "python3" ? { code: 127, stderr: "not found" } : { code: 0, stderr: "" }),
    canWrite: () => true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ["python3"]);
  assert.match(String(result.checks.find((c) => c.id === "python3")?.detail), /python3/);
});

test("preflight RECORDS but does not block on npx impeccable", async () => {
  const home = homeWithKeyFile();
  const script = join(home, "gemini-image.sh");
  writeFileSync(script, "#!/usr/bin/env bash\n", "utf8");
  const result = await designPreflight({
    env: {},
    homeDir: home,
    workspace: home,
    capability: detectDesignCapability({ env: {}, homeDir: home, imageScript: script }),
    run: async (command, args) =>
      command === "npx" && args.includes("impeccable") ? { code: 1, stderr: "not found" } : { code: 0, stderr: "" },
    canWrite: () => true,
  });
  assert.equal(result.ok, true, "one skill degrades; the lane does not");
  const check = result.checks.find((c) => c.id === "npx-impeccable");
  assert.equal(check?.ok, false);
  assert.equal(check?.blocking, false);
  assert.match(String(check?.detail), /impeccable/);
});

test("preflight blocks when NO key resolves, and names the degrade path", async () => {
  const bare = mkdtempSync(join(tmpdir(), "design-home-none-"));
  const script = join(bare, "gemini-image.sh");
  writeFileSync(script, "#!/usr/bin/env bash\n", "utf8");
  const result = await designPreflight({
    env: {},
    homeDir: bare,
    workspace: bare,
    capability: detectDesignCapability({ env: {}, homeDir: bare, imageScript: script }),
    run: ok,
    canWrite: () => true,
  });
  assert.deepEqual(result.blockers, ["gemini-key"]);
});

test("every check reports a DETAIL — a bare false is not actionable at 3am", async () => {
  const bare = mkdtempSync(join(tmpdir(), "design-home-detail-"));
  const result = await designPreflight({
    env: {},
    homeDir: bare,
    workspace: bare,
    capability: detectDesignCapability({ env: {}, homeDir: bare, imageScript: join(bare, "absent.sh") }),
    run: fails,
    canWrite: () => false,
  });
  for (const check of result.checks) assert.ok(check.detail.length > 0, `${check.id} has no detail`);
  assert.ok(result.checks.length === 5, "all five §7.5 rows are checked");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './design-capability.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design-capability.ts
/**
 * design-capability.ts — can this machine actually make a mockup, and if not, WHY.
 *
 * SPEC §7.5 IS A TABLE OF FIVE WAYS THE IMAGE CHAIN BREAKS AND ONE REASON NONE OF
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
 * source won and nothing else. CLAUDE.md:18 and §7.5's last-but-one row: the two
 * Gemini variables are deliberately absent from `STRIPPED_ENV_NAMES`
 * (`subprocess-env.ts:39-55`) so they survive into the subprocess — which is
 * intended, and which is exactly why nothing here may ever print one.
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
  const stripped = contents.replace(/\s+/gu, "");
  return stripped.length > 0
    ? { available: true, source: "~/.gemini/api_key" }
    : { available: false, source: null };
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 11 tests in `design-capability.test.js`.

- [ ] **Step 5: Negative control — prove each blocker can go red, and prove the key never leaks**

1. Change `blocking: true` to `blocking: false` on the `python3` check. Re-run.
   Expected: FAIL with `preflight BLOCKS on a missing python3`. Restore.
2. Change `geminiKeyAvailable` to return `{ available: true, source: "GEMINI_API_KEY" }` when the env var is set, **and** add the value under a `value` field. Re-run.
   Expected: FAIL with `the resolution NEVER carries the key value`. Restore.
3. Make `detectDesignCapability` return `video: existsSync(video)` (dropping the key conjunct). Re-run.
   Expected: FAIL with `video capability requires BOTH the script and a key`. Restore.

- [ ] **Step 6: Prove the network row of §7.5 is still what the spec assumed**

§7.5's "Network egress" row says `sandbox.network` is unconfigured and the mitigation is "verify CLI default; allowlist the host if a network policy is ever added". Add this assertion to `dashboard/server/src/design-capability.test.ts` so the day someone adds a network policy, this goes red instead of the lane silently losing `generativelanguage.googleapis.com`:

```ts
test("sandbox.network is still unconfigured — if that changes, the API host needs an allowlist", async () => {
  const { buildOptions } = await import("./builders/claude-builder.js");
  const options = buildOptions(
    {
      runId: "r1", prompt: "p", workspace: process.cwd(), sealedRoots: [], allowedAgents: [],
      modelId: "claude-opus-5", effort: null, resumeSessionId: null,
      signal: new AbortController().signal,
      sink: {} as never, env: {},
    },
    false,
  );
  const sandbox = options.sandbox as Record<string, unknown>;
  assert.equal(
    "network" in sandbox, false,
    "sandbox.network is now configured: gemini-image.sh:71 curls generativelanguage.googleapis.com, " +
      "so that host must be allowlisted or every generation fails with no PNG (spec §7.5).",
  );
});
```

Run it. Expected: PASS. Then temporarily add `network: {}` to the `sandbox` literal in `claude-builder.ts:1008` and re-run.
Expected: FAIL with `sandbox.network is now configured`. Restore `claude-builder.ts` immediately — it is a hot file.

- [ ] **Step 7: Commit**

```bash
git commit -F - -- dashboard/server/src/design-capability.ts dashboard/server/src/design-capability.test.ts <<'MSG'
feat(design): capability detection and preflight for the image chain

Spec §7.5 lists five ways the chain breaks and one reason none of them is
visible: autoAllowBashIfSandboxed means Bash never reaches decideToolPermission,
so a missing python3, an unresolvable npx impeccable, a TMPDIR outside
allowWrite and an unresolvable key all produce the same observable — zero PNGs
and no error. Each row is now checked before the lane runs and written down.

The key value never leaves this file: the resolution says WHICH source won and
nothing else. GEMINI_API_KEY/NANOBANANA_API_KEY are deliberately absent from
STRIPPED_ENV_NAMES so they survive into the subprocess, which is exactly why
nothing here may print one.

Video capability is false while gemini-video.sh does not exist, so nothing in 2b
can demand video (§7.1a).
MSG
```

---

### Task 3: `TMPDIR` inside the workspace, and the motion-bar flip

**Why this is a first-class task and not a footnote:** §7.5 calls `TMPDIR` **"Most likely silent breakage."** `gemini-image.sh:43` does `mktemp -d` in the *system* temp dir; `sandbox.filesystem.allowWrite` is `[workspace]` (`claude-builder.ts:1032`). The script writes its request body and response there. If the sandbox refuses that write, the script dies before it ever calls the API — with no PNG and no error the permission layer can see.

This task also owns the flip `claude-builder.ts` explicitly deferred: *"the ORCHESTRATOR turns it on for the runs the lane routing says are visual. **Phase 2b owns that flip**"* (`claude-builder.ts` hooks block, `MOTION_BAR_ENV`).

**Files:**
- Create: `dashboard/server/src/design-env.ts`
- Create: `dashboard/server/src/design-env.test.ts`

**Interfaces:**
- Consumes: `MOTION_BAR_ENV` from `./builders/claude-builder.js` (exported at `:197` — imported, never retyped).
- Produces:
```ts
export const DESIGN_TMP_DIR = ".design-tmp";
export function designTmpDirFor(workspace: string): string;
export function designSubprocessEnv(
  base: NodeJS.ProcessEnv,
  opts: { workspace: string; motionBar: boolean },
): NodeJS.ProcessEnv;
```

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design-env.test.ts
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MOTION_BAR_ENV } from "./builders/claude-builder.js";
import { STRIPPED_ENV_NAMES, subscriptionSubprocessEnv } from "./subprocess-env.js";
import { designSubprocessEnv, designTmpDirFor, DESIGN_TMP_DIR } from "./design-env.js";

const WS = "/runs/r1/workspace";

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

// THE MEASUREMENT, NOT THE ASSUMPTION. `mktemp -d` is an external tool and the
// whole TMPDIR mitigation rests on it honouring the variable. Instance 10 in this
// project's defect log is Playwright silently accepting an option it emulated
// nothing for; this is the same shape of claim, so it is executed.
test("EXECUTED: mktemp -d actually honours TMPDIR", () => {
  const workspace = mkdtempSync(join(tmpdir(), "design-ws-"));
  const env = designSubprocessEnv(process.env, { workspace, motionBar: false });
  execFileSync("mkdir", ["-p", String(env["TMPDIR"])]);
  const made = execFileSync("mktemp", ["-d"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" }).trim();
  assert.ok(
    made.startsWith(`${String(env["TMPDIR"])}/`),
    `mktemp -d wrote to ${made}, outside the workspace TMPDIR — the §7.5 mitigation does not work on ` +
      `this platform and gemini-image.sh:43 will write outside allowWrite`,
  );
});

test("EXECUTED, NEGATIVE CONTROL: without TMPDIR, mktemp -d lands OUTSIDE the workspace", () => {
  // Without this arm the test above proves nothing: it would pass on a platform
  // where mktemp ignored TMPDIR and happened to default somewhere inside.
  const workspace = mkdtempSync(join(tmpdir(), "design-ws-control-"));
  const bare = { ...process.env };
  delete bare["TMPDIR"];
  const made = execFileSync("mktemp", ["-d"], { env: bare, encoding: "utf8" }).trim();
  assert.equal(made.startsWith(`${workspace}/`), false, "the control must land outside the workspace");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './design-env.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design-env.ts
/**
 * design-env.ts — the two environment decisions a DESIGN run needs.
 *
 * TMPDIR IS THE MOST LIKELY SILENT BREAKAGE IN THE WHOLE IMAGE CHAIN (spec §7.5,
 * its own words). `gemini-image.sh:43` does `mktemp -d` in the SYSTEM temp dir
 * and writes the request body and the API response there;
 * `sandbox.filesystem.allowWrite` is `[workspace]` (claude-builder.ts:1032). If
 * the sandbox refuses that write the script dies before it ever reaches the API,
 * and because `autoAllowBashIfSandboxed: true` means Bash never reaches
 * `decideToolPermission`, nothing on the host sees a permission event. The lane
 * simply produces nothing.
 *
 * THE MOTION-BAR FLIP IS OURS BY EXPLICIT HANDOVER. claude-builder.ts registers
 * the Layer-2 Stop hooks only when `DASHBOARD_MOTION_BAR=1` and says so in
 * prose: "the ORCHESTRATOR turns it on for the runs the lane routing says are
 * visual. Phase 2b owns that flip." Phase 2a measured that always-on would block
 * a legitimate build of this repo's own client, so the flag is set here, per run,
 * from the lane mode — and an inherited value is REMOVED rather than respected,
 * because an operator's shell must not arm a completion gate on a CLI ticket.
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
```

Wire it in `orchestrator.ts` at the `env:` argument of `builder.build(...)` (currently `env: this.#deps.env` at `:718`):

```ts
      env: designSubprocessEnv(this.#deps.env, {
        workspace: runPaths.workspace,
        // The lane routing decides this, never the operator's shell. Phase 2a
        // measured that an always-on motion bar blocks a legitimate build of an
        // internal UI, so it arms only where the DESIGN lane runs.
        motionBar: laneMode !== "off",
      }),
```

and create the directory in `#prepareWorkspace` beside the git init, so the very first `mktemp -d` has somewhere to go:

```ts
    mkdirSync(designTmpDirFor(runPaths.workspace), { recursive: true });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 8 tests in `design-env.test.js` — including both executed `mktemp` arms.

- [ ] **Step 5: Negative control — break each decision and watch it go red**

1. Drop the `env["TMPDIR"] = …` line. Re-run.
   Expected: FAIL with `TMPDIR is inside the workspace` **and** `EXECUTED: mktemp -d actually honours TMPDIR`. Restore.
2. Replace `else delete env[MOTION_BAR_ENV];` with `else {}`. Re-run.
   Expected: FAIL with `an inherited DASHBOARD_MOTION_BAR is not allowed to arm a non-visual run`. Restore.
3. Add `"GEMINI_API_KEY"` to `STRIPPED_ENV_NAMES` in `subprocess-env.ts`. Re-run.
   Expected: FAIL with `the two Gemini key names are NOT stripped`. **Restore immediately** — this is the change that would silently kill the lane in production.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-env.ts dashboard/server/src/design-env.test.ts dashboard/server/src/orchestrator.ts <<'MSG'
feat(design): TMPDIR inside the workspace, and the motion-bar flip

gemini-image.sh:43 does mktemp -d in the system temp dir while allowWrite is
[workspace] — spec §7.5 calls it the most likely silent breakage in the image
chain, and it is silent because autoAllowBashIfSandboxed means Bash never
reaches decideToolPermission. TMPDIR is now set inside the workspace, and the
test EXECUTES mktemp -d in both directions rather than assuming the variable is
honoured.

claude-builder.ts deferred the DASHBOARD_MOTION_BAR flip to Phase 2b in prose;
it now arms per run from the lane mode, and an inherited value is removed so an
operator's shell cannot arm a completion gate on a CLI ticket.
MSG
```

---

### Task 4: `designLaneMode` — degrade is a state, not an absence

**Why:** §6.5's predicate has three terms and one of them (`geminiKeyAvailable()`) does **not** mean "do not run the lane". The spec is explicit: *"If false, DESIGN degrades — it does not block. `taste-frontend-expert` still art-directs and produces written direction; the visual gate falls back to rule-based scoring with no reference PNGs; the canvas shows the lane as degraded."* A two-valued boolean cannot express that, and collapsing it into one is how a degraded lane becomes indistinguishable from a lane that never ran — which is THE TRAP.

**Files:**
- Create: `dashboard/server/src/design-lane.ts`
- Create: `dashboard/server/src/design-lane.test.ts`
- Modify: `dashboard/server/src/agent-shortlist.ts:92-99` (`designLaneRuns`)

**Interfaces:**
- Consumes: `Surface` from `./agent-shortlist.js`; `DesignCapability` from Task 2.
- Produces:
```ts
export type DesignLaneMode = "full" | "degraded" | "off";
export function visualIntent(ticketText: string): boolean;
/** The PURE half of the predicate: the two terms that can return "off". */
export function designSurfaceGate(surface: Surface, ticketText: string): boolean;
export function designLaneMode(input: {
  surface: Surface;
  ticketText: string;
  capability: DesignCapability;
  preflightOk: boolean;
}): DesignLaneMode;
```

**Why `shortlistFor` is still a permission boundary after this widening — say it, or a reviewer rejects the task on purity grounds with the defence undiscovered.** `surface.ts` states the rule: *"a boundary that awaits a model call has a failure mode… and a boundary with a failure mode is not a boundary."* `designMode` now depends transitively on `designPreflight`, which spawns `npx`. **It does not weaken the boundary**, because `designLaneRuns` is `mode !== "off"` and **`"off"` is decided by `designSurfaceGate` alone** — surface plus `visualIntent`, both pure, both synchronous, neither able to fail. The preflight can only move the lane between `full` and `degraded`, and those two shortlist identically. `designSurfaceGate` is exported separately so that fact is checkable rather than argued.

It also means the orchestrator can **skip the preflight entirely when the gate is false**: a `cli` ticket must not spend up to 20 seconds probing `npx` for a lane that cannot run.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design-lane.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DesignCapability } from "./design-capability.js";
import { designLaneMode, designSurfaceGate, visualIntent } from "./design-lane.js";

const WITH_KEY: DesignCapability = {
  imageScript: "/scripts/gemini-image.sh",
  key: { available: true, source: "GEMINI_API_KEY" },
  video: false,
};
const NO_KEY: DesignCapability = {
  imageScript: "/scripts/gemini-image.sh",
  key: { available: false, source: null },
  video: false,
};

function mode(surface: Parameters<typeof designLaneMode>[0]["surface"], ticketText: string, capability = WITH_KEY) {
  return designLaneMode({ surface, ticketText, capability, preflightOk: true });
}

test("a pure web-ui ticket runs DESIGN with no visual-intent words at all (spec §6.5)", () => {
  // "The `|| surface === "web-ui"` term is deliberate: for a pure web-UI ticket
  // the deliverable IS the visual, and the standing motion bar applies whether or
  // not the ticket says design."
  assert.equal(mode("web-ui", "a page listing the last ten builds"), "full");
});

test("fullstack requires EXPLICIT visual intent — the admin CRUD carve-out", () => {
  // "`fullstack` requires explicit visual intent, so an internal admin CRUD
  // screen does not pay for five mockups."
  assert.equal(mode("fullstack", "an internal admin screen with an api for editing rows"), "off");
  assert.equal(mode("fullstack", "an api plus a landing page; make the design feel considered"), "full");
});

test("a non-visual surface never runs DESIGN", () => {
  for (const surface of ["api", "cli", "library", "background-jobs"] as const) {
    assert.equal(mode(surface, "make it beautiful, a gorgeous design"), "off");
  }
});

test("NO KEY DEGRADES, IT DOES NOT BLOCK — and degraded is NOT off", () => {
  // The whole point of the three-valued return. Spec §6.5: taste-frontend-expert
  // still art-directs; the gate falls back to rule-based scoring. If this ever
  // returns "off", a zero-image lane and a never-ran lane become the same thing.
  assert.equal(mode("web-ui", "a portfolio", NO_KEY), "degraded");
  assert.notEqual(mode("web-ui", "a portfolio", NO_KEY), "off");
});

test("a failed preflight degrades too — a lane that cannot generate must say so up front", () => {
  assert.equal(
    designLaneMode({ surface: "web-ui", ticketText: "a portfolio", capability: WITH_KEY, preflightOk: false }),
    "degraded",
  );
});

test("the OFF decision is PURE — no capability, no preflight, nothing that can await", () => {
  // shortlistFor feeds a permission boundary and surface.ts forbids one that can
  // fail. Everything that decides whether the DESIGN agents are shortlisted has
  // to be answerable from these two arguments alone.
  assert.equal(designSurfaceGate("web-ui", "a page"), true);
  assert.equal(designSurfaceGate("cli", "make it beautiful"), false);
  assert.equal(designSurfaceGate("fullstack", "an api and an admin screen"), false);
  for (const capability of [WITH_KEY, NO_KEY]) {
    for (const preflightOk of [true, false]) {
      const off = designLaneMode({ surface: "cli", ticketText: "a beautiful cli", capability, preflightOk });
      assert.equal(off, "off", "no capability state may turn a non-visual surface on, or a visual one off");
    }
  }
});

test("visualIntent reads intent, not incidental words", () => {
  assert.equal(visualIntent("make the design feel considered, not templated"), true);
  assert.equal(visualIntent("art direction and a strong visual identity"), true);
  assert.equal(visualIntent("fix the database migration for the designs table"), false);
  assert.equal(visualIntent("redesign the checkout"), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './design-lane.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design-lane.ts
/**
 * design-lane.ts — does the DESIGN lane run, and in which of its two working
 * states.
 *
 * SPEC §6.5, VERBATIM:
 *
 *   designLane = surface ∈ {web-ui, fullstack}
 *             && (visualIntent(ticket) || surface === "web-ui")
 *             && geminiKeyAvailable()
 *
 * AND THE SENTENCE THAT FOLLOWS IT IS WHY THIS RETURNS THREE VALUES AND NOT A
 * BOOLEAN: "If false, DESIGN degrades — it does not block. `taste-frontend-expert`
 * still art-directs and produces written direction; the visual gate falls back to
 * rule-based scoring with no reference PNGs; the canvas shows the lane as
 * degraded. Blocking a build on an absent image key is a worse failure than
 * shipping without mockups."
 *
 * So the third term does not turn the lane OFF; it moves it to `degraded`. The
 * first two terms are what turn it off. Collapsing the two into one boolean is
 * precisely how a lane that could not generate becomes indistinguishable from a
 * lane that had nothing to generate — see design-outcome.ts, which exists to keep
 * those two apart.
 *
 * PURE AND SYNCHRONOUS, like `classifySurface` and for the same reason: the mode
 * decides `allowedAgents` for segment 1, which is a permission boundary, and a
 * boundary that can await has a failure mode.
 */

import type { Surface } from "./agent-shortlist.js";
import type { DesignCapability } from "./design-capability.js";

export type DesignLaneMode = "full" | "degraded" | "off";

/**
 * Whole words only, for the reason `surface.ts` spells out: `includes("ui")`
 * matches "build", and a substring hit here would route an API ticket into five
 * paid image generations.
 */
const VISUAL_INTENT = [
  "design",
  "designs",
  "designed",
  "redesign",
  "art direction",
  "art-directed",
  "visual",
  "visuals",
  "aesthetic",
  "aesthetics",
  "look and feel",
  "brand",
  "branding",
  "mockup",
  "mockups",
  "beautiful",
  "polished",
  "considered",
  "typography",
  "palette",
  "motion",
  "animation",
  "animations",
] as const;

function mentions(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const literal = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![a-z0-9])${literal}(?![a-z0-9])`, "u").test(text);
  });
}

/**
 * Does the ticket ASK for design?
 *
 * "the designs table" is a schema, not a brief, so the match is on the word in
 * isolation and the surface gate in front of it does the rest of the work: a
 * `fullstack` ticket has to say so, a `web-ui` ticket never has to.
 */
export function visualIntent(ticketText: string): boolean {
  return mentions(ticketText.toLowerCase(), VISUAL_INTENT);
}

/**
 * THE PURE HALF, AND THE ONLY HALF THAT CAN SAY "off".
 *
 * `shortlistFor` feeds a permission boundary, and `surface.ts` is explicit that a
 * boundary which can await or fail is not a boundary. Everything that decides
 * whether the DESIGN agents are shortlisted lives in this function: surface and
 * `visualIntent`, both pure, both total. The capability terms below can only
 * choose between `full` and `degraded`, which shortlist identically.
 *
 * Exported so the orchestrator can ask it BEFORE running the preflight — a `cli`
 * ticket has no business spending 20 seconds probing `npx`.
 */
export function designSurfaceGate(surface: Surface, ticketText: string): boolean {
  if (surface !== "web-ui" && surface !== "fullstack") return false;
  return visualIntent(ticketText) || surface === "web-ui";
}

export function designLaneMode(input: {
  surface: Surface;
  ticketText: string;
  capability: DesignCapability;
  preflightOk: boolean;
}): DesignLaneMode {
  if (!designSurfaceGate(input.surface, input.ticketText)) return "off";
  // The third term of §6.5's predicate. False here means DEGRADED, never off.
  if (!input.capability.key.available || input.capability.imageScript === null) return "degraded";
  if (!input.preflightOk) return "degraded";
  return "full";
}
```

Then widen `agent-shortlist.ts:92-99` so a degraded lane keeps its agents — without this, the "still art-directs" half of §6.5 has nobody to do it:

```ts
/**
 * DESIGN is the only conditional lane (spec 6.5). Phase 2b replaces the
 * surface-only stub with the real three-term predicate — but note which way it
 * degrades: `designLaneMode` returns "degraded" when no Gemini key resolves, and
 * a DEGRADED LANE STILL NEEDS ITS AGENTS. Spec 6.5: "taste-frontend-expert still
 * art-directs and produces written direction." Shortlisting on `mode === "full"`
 * would delete the art direction along with the images.
 */
function designLaneRuns(mode: DesignLaneMode): boolean {
  return mode !== "off";
}
```

with `shortlistFor` taking the mode alongside the surface:

```ts
export function shortlistFor(surface: Surface, designMode: DesignLaneMode = "off"): readonly string[] {
  const design: readonly string[] = designLaneRuns(designMode) ? DELIVERY_LANES.design : [];
  // …unchanged below…
}
```

**The default is `"off"`, and that is deliberate:** every existing caller keeps compiling and keeps its current behaviour, and a caller that forgets to pass the mode under-delegates rather than handing an unclassified ticket a lane it did not earn. `agent-shortlist.test.ts`'s existing cases pass no second argument and stay green; add one case that passes `"degraded"` and asserts both DESIGN agents are present.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS — 6 new tests, plus every pre-existing `agent-shortlist.test.js` case still green.

- [ ] **Step 5: Negative control**

1. Change the key branch to `return "off";`. Re-run.
   Expected: FAIL with `NO KEY DEGRADES, IT DOES NOT BLOCK — and degraded is NOT off`. Restore.
2. Change `designLaneRuns` to `mode === "full"`. Re-run.
   Expected: FAIL on the new `agent-shortlist.test.ts` case (`a degraded design lane keeps taste-frontend-expert`). Restore.
3. Delete the `|| input.surface === "web-ui"` term. Re-run.
   Expected: FAIL with `a pure web-ui ticket runs DESIGN with no visual-intent words at all`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-lane.ts dashboard/server/src/design-lane.test.ts dashboard/server/src/agent-shortlist.ts dashboard/server/src/agent-shortlist.test.ts <<'MSG'
feat(design): the §6.5 lane predicate, with degrade as a state

The third term of the predicate — geminiKeyAvailable() — does not turn the lane
off. The spec is explicit that DESIGN degrades rather than blocking, so the mode
is three-valued: a lane that could not generate must stay distinguishable from a
lane that had nothing to generate, which is the failure this whole phase is
designed against.

designLaneRuns therefore keeps taste-frontend-expert and ui-designer shortlisted
in degraded mode: shortlisting on "full" would delete the written art direction
along with the images.
MSG
```

---

### Task 5: The DESIGN segment prompt — §7.2, copied not paraphrased

**Why:** the lane is an agent reading instructions. Every flag, the model default, the retry cap and the aspect set are copied verbatim from the spec and from `taste-frontend-expert.md`; nothing here re-derives them. Getting `-i` wrong loses the palette across the set; getting the retry cap wrong doubles the metered spend.

**Files:**
- Create: `dashboard/server/src/design-prompt.ts`
- Create: `dashboard/server/src/design-prompt.test.ts`

**Interfaces:**
- Consumes: `DesignCapability` (Task 2); `DesignLaneMode` (Task 4); `DESIGN_REFS_DIR`, `DESIGN_MANIFEST_FILE`, `manifestPathFor` (Task 1).
- Produces:
```ts
export const DESIGN_DIALS = ["DESIGN_VARIANCE", "MOTION_INTENSITY", "VISUAL_DENSITY"] as const;
export const MIN_DESIGN_REFS = 5;
export const MAX_IMAGE_RETRIES = 2;
export const DESIGN_CHOICE_FILE = "choice.json";
export function designSegmentPrompt(input: {
  ticketText: string;
  workspace: string;
  mode: DesignLaneMode;
  capability: DesignCapability;
  autoChoose: boolean;
}): string;
```

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design-prompt.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DesignCapability } from "./design-capability.js";
import { designSegmentPrompt, DESIGN_DIALS, MIN_DESIGN_REFS } from "./design-prompt.js";

const WS = "/runs/r1/workspace";
const CAP: DesignCapability = {
  imageScript: "/Users/o/.claude/scripts/gemini-image.sh",
  key: { available: true, source: "GEMINI_API_KEY" },
  video: false,
};

function full(overrides: Partial<Parameters<typeof designSegmentPrompt>[0]> = {}): string {
  return designSegmentPrompt({
    ticketText: "a portfolio",
    workspace: WS,
    mode: "full",
    capability: CAP,
    autoChoose: false,
    ...overrides,
  });
}

test("the prompt names the script by its ABSOLUTE path — nothing on PATH substitutes", () => {
  assert.match(full(), /\/Users\/o\/\.claude\/scripts\/gemini-image\.sh/);
});

test("the flags are the script's flags, verbatim", () => {
  const p = full();
  assert.match(p, /-a\b/);
  assert.match(p, /-o\b/);
  assert.match(p, /-i\b/);
  assert.match(p, /1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9/);
});

test("the model default is stated and is Nano Banana 2", () => {
  assert.match(full(), /gemini-3\.1-flash-image-preview/);
});

test("generation is STRICTLY SEQUENTIAL and -i chains off the last image", () => {
  // Spec §7.2: `-i reference.png` "is what holds the palette across the set, and
  // why generation is strictly sequential". A prompt that permits parallel
  // generation produces five unrelated images and a manifest that lies about
  // being a set.
  const p = full();
  assert.match(p, /sequential/i);
  assert.match(p, /-i .*(previous|last|best sibling)/i);
});

test("the closed loop and its cap are stated: Read, critique, max 2 retries", () => {
  const p = full();
  assert.match(p, /max(imum)? 2 retries/i);
  assert.match(p, /Read the image/i);
});

test("at least five PNGs and a manifest, at the exact paths the host will read", () => {
  const p = full();
  assert.match(p, new RegExp(`at least ${String(MIN_DESIGN_REFS)}`, "i"));
  assert.match(p, /\/runs\/r1\/workspace\/design-refs\//);
  assert.match(p, /\/runs\/r1\/workspace\/design-refs\/manifest\.json/);
  for (const field of ["section", "aspect", "intent"]) assert.ok(p.includes(field), `manifest field ${field}`);
});

test("THE KEY IS NEVER IN THE PROMPT — not the value, not a read instruction", () => {
  // CLAUDE.md:18 and spec §7.5. The script resolves the key itself; an agent
  // never needs to see it, and a prompt that told it to `cat ~/.gemini/api_key`
  // would put the key in the transcript, the build log and the canvas.
  const p = designSegmentPrompt({
    ticketText: "a portfolio",
    workspace: WS,
    mode: "full",
    capability: { ...CAP, key: { available: true, source: "~/.gemini/api_key" } },
    autoChoose: false,
  });
  assert.doesNotMatch(p, /cat .*api_key/i);
  assert.doesNotMatch(p, /\$GEMINI_API_KEY/);
  assert.doesNotMatch(p, /echo .*KEY/i);
});

test("2b NEVER asks for video — the capability flag is false and the ask is gated on it", () => {
  // §7.1a: "Until 2c lands, the gate must not demand video." An agent told to
  // produce a scroll-scrubbed .mp4 with no gemini-video.sh either fakes it or
  // burns the lane's turns discovering it cannot.
  const p = full();
  assert.doesNotMatch(p, /\.mp4/);
  assert.doesNotMatch(p, /gemini-video\.sh/);
});

test("with the video capability present, the ask appears — the flag is load-bearing", () => {
  const p = full({ capability: { ...CAP, video: true } });
  assert.match(p, /\.mp4/);
});

test("a degraded lane is told to art-direct in WRITING and NOT to fake images", () => {
  // Spec §6.5: "taste-frontend-expert still art-directs and produces written
  // direction". And Phase 2a's AS-PLACEHOLDER-IMAGE denies picsum/placehold.co
  // at write time, so a fallback to placeholder art is a denial loop, not a fix.
  const p = full({ mode: "degraded", capability: { ...CAP, key: { available: false, source: null } } });
  assert.match(p, /written (art )?direction/i);
  assert.doesNotMatch(p, /gemini-image\.sh/);
  assert.match(p, /picsum|placehold\.co/i, "it must name what it may not reach for");
});

test("the three dials are named verbatim, and in the prompt the builders will inherit", () => {
  const p = full();
  for (const dial of DESIGN_DIALS) assert.ok(p.includes(dial), `${dial} is missing`);
});

test("auto-choose asks ui-designer, never the author (§17.3 rule 3)", () => {
  const p = full({ autoChoose: true });
  assert.match(p, /ui-designer/);
  assert.match(p, /choice\.json/);
  assert.doesNotMatch(p, /taste-frontend-expert (picks|chooses|selects)/i);
});

test("without auto-choose the prompt does NOT ask anyone to pick — the owner will", () => {
  assert.doesNotMatch(full({ autoChoose: false }), /choice\.json/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './design-prompt.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design-prompt.ts
/**
 * design-prompt.ts — what the DESIGN lane is actually told.
 *
 * EVERY FLAG, THE MODEL DEFAULT, THE ASPECT SET AND THE RETRY CAP ARE COPIED,
 * NOT RECALLED. Sources: spec §7.2 and `~/.claude/agents/taste-frontend-expert.md`
 * (:46 for the closed loop). `-i` is the term that matters most: it is "what
 * holds the palette across the set, and why generation is strictly sequential"
 * (§7.2). Drop it and five images become five unrelated pictures with a manifest
 * claiming they are a set.
 *
 * THE KEY IS NEVER MENTIONED. The script resolves it itself
 * (`$GEMINI_API_KEY` → `$NANOBANANA_API_KEY` → `~/.gemini/api_key`), so an agent
 * never needs it — and a prompt that so much as told it where to look would put
 * the key in the transcript, the build log, `prompt.txt` and the canvas.
 *
 * THE VIDEO ASK IS GATED ON `capability.video`, WHICH IS FALSE THROUGH 2b
 * (§7.1a). The flag gates what is ASKED FOR; it never removes an accepted
 * satisfier from the Layer-2 gate. Those are different things and conflating them
 * would make the gate stricter, which is the opposite of degrade-don't-block.
 */

import { join } from "node:path";
import type { DesignCapability } from "./design-capability.js";
import type { DesignLaneMode } from "./design-lane.js";
import { manifestPathFor, refsDirFor } from "./design-manifest.js";

/** Spec §7.3, verbatim. Injected here and again into every build agent's prompt. */
export const DESIGN_DIALS = ["DESIGN_VARIANCE", "MOTION_INTENSITY", "VISUAL_DENSITY"] as const;

/** Spec §7.2: "≥5 PNGs land in `design-refs/`". */
export const MIN_DESIGN_REFS = 5;

/** taste-frontend-expert.md:46 — "max 2 retries per image". */
export const MAX_IMAGE_RETRIES = 2;

/** Where the auto-chooser writes its scoring. Read and validated by the host. */
export const DESIGN_CHOICE_FILE = "choice.json";

export function designSegmentPrompt(input: {
  ticketText: string;
  workspace: string;
  mode: DesignLaneMode;
  capability: DesignCapability;
  autoChoose: boolean;
}): string {
  const refsDir = refsDirFor(input.workspace);
  const manifest = manifestPathFor(input.workspace);
  const lines: string[] = [
    "DESIGN LANE — art direction, before any markup exists.",
    "",
    "This segment produces the design the build is then held to. It writes no",
    "application code: the next segment does that, and it will be given exactly",
    "what you leave behind on disk.",
    "",
    `Ticket: ${input.ticketText}`,
    "",
  ];

  if (input.mode === "degraded") {
    lines.push(
      "IMAGE GENERATION IS UNAVAILABLE ON THIS RUN, and that is expected rather than a",
      "fault — no Gemini key resolves, or the preflight found the chain broken. Do not",
      "attempt it and do not look for a key.",
      "",
      "Produce WRITTEN ART DIRECTION instead, at " + join(refsDir, "direction.md") + ":",
      "the palette with hex values and the role of each, the type system with families,",
      "scale steps and tracking, the section order with the weight each carries, and the",
      "one motion moment the page is built around. Written direction is what the build",
      "segment will be given in place of stills, so it has to be specific enough to",
      "build from.",
      "",
      "DO NOT substitute placeholder imagery. picsum, placehold.co and",
      "unsplash.com/random are denied at write time by the anti-slop hook, so reaching",
      "for them costs the run a denial loop rather than an image. A chosen photograph",
      "with a real URL is fine; a random one is not.",
      "",
    );
  } else {
    lines.push(
      "IMAGE GENERATION",
      "",
      `Use the local tool at ${String(input.capability.imageScript)} — that exact absolute`,
      "path. It resolves its own API credential; you never need one and must never look",
      "for one.",
      "",
      `  ${String(input.capability.imageScript)} "<full art-directed prompt>" -a 16:9 -o ${join(refsDir, "01-hero.png")}`,
      "",
      "  -a  aspect ratio: 1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9   (default 16:9)",
      "  -o  output path",
      "  -i  a reference image, for style-consistency and edit passes",
      "  -m  model override (default gemini-3.1-flash-image-preview — Nano Banana 2)",
      "",
      "It prints the output path on success.",
      "",
      "STRICTLY SEQUENTIAL, ONE IMAGE AT A TIME. After the first image, pass the",
      "previous image with `-i` on every subsequent generation. That is what holds the",
      "palette across the set; generating in parallel produces five unrelated pictures.",
      "",
      `CLOSED LOOP, MANDATORY. After each generation, Read the image file and critique it`,
      `against the routed skill's rules. Regenerate a weak image with a corrected prompt —`,
      `max ${String(MAX_IMAGE_RETRIES)} retries per image — using -i with the best sibling to hold the palette.`,
      "",
      `DELIVERABLE: at least ${String(MIN_DESIGN_REFS)} PNGs in ${refsDir}/, one per section, plus a`,
      `manifest at ${manifest}:`,
      "",
      "  {",
      '    "version": 1,',
      '    "refs": [',
      `      { "path": "${join(refsDir, "01-hero.png")}",`,
      '        "section": "hero",',
      '        "aspect": "16:9",',
      '        "intent": "what this image is FOR, in one sentence" }',
      "    ]",
      "  }",
      "",
      "`path` must be ABSOLUTE and inside that directory. A manifest with a path",
      "outside it is rejected wholesale by the host, and the lane then counts as having",
      "produced nothing.",
      "",
    );
    if (input.capability.video) {
      lines.push(
        "MOTION LEGS ARE AVAILABLE ON THIS RUN. Sections you mark for animation may be",
        "given a scrubbable .mp4 and a .webp poster; generate those stills at 16:9 or",
        "9:16, which is all the video model accepts.",
        "",
      );
    } else {
      lines.push(
        "NO VIDEO ON THIS RUN. There is no image-to-video tool installed, so do not plan",
        "a scroll-scrubbed video world and do not reference an .mp4 that will not exist.",
        "Motion is authored in code by the build segment, from these stills.",
        "",
      );
    }
  }

  lines.push(
    "THE THREE DIALS. State a value for each, in the manifest's sibling",
    `${join(refsDir, "direction.md")}, and justify it in one line. These exact names are`,
    "carried verbatim into every build agent's prompt, so the build is held to them:",
    ...DESIGN_DIALS.map((dial) => `  - ${dial}`),
    "",
  );

  if (input.autoChoose) {
    lines.push(
      "CHOOSING THE DESIGN. This run selects automatically. Delegate to `ui-designer` —",
      "not to yourself — to score every mockup against the brief and the taste rules,",
      `pick ONE, and write ${join(refsDir, DESIGN_CHOICE_FILE)}:`,
      "",
      '  { "chosen": "<absolute path of one ref>", "reason": "why, in two sentences" }',
      "",
      "The agent that authored the art direction does not grade or choose it. The host",
      "validates the chosen path against the manifest and records who chose and why.",
      "",
    );
  }

  lines.push(
    "WHEN THIS SEGMENT IS DONE, stop. Do not start implementation: the build agents",
    "are not reachable from this segment and every attempt to start one is denied.",
  );
  return lines.join("\n");
}
```

**What a PARTIAL lane does, stated so it is not an unspecified branch.** `too-few-images` and `manifest-invalid` (Task 7) **do not stop the run** — degrade-don't-block applies here as everywhere else, and three real mockups are better than none. What changes is what crosses the seam: the *report* keeps the discrepancy, and the *prompt* is built from `pruneMissingRefs(manifest)` (Task 1), so no build agent is ever handed a path that resolves to nothing. If the locked mockup is itself one of the missing files, the lock drops and the gate falls back to the rule-based floor, which is the honest answer.

**One detail worth stating rather than leaving to be discovered:** the degraded branch names `picsum`/`placehold.co` on purpose. Phase 2a's `AS-PLACEHOLDER-IMAGE` denies those at write time, and `taste-frontend-expert.md`'s own fallback instruction is "fall back to taste-skill §4.8 priority 2 (real photo URLs) or labeled TODO slots". A degraded lane that reaches for a random Unsplash URL would hit a hook denial three times and escalate — a self-inflicted loop the prompt can simply prevent.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 13 tests in `design-prompt.test.js`.

- [ ] **Step 5: Negative control — prove the video gate and the key rule can go red**

1. Move the `.mp4` lines out of the `if (input.capability.video)` branch so they always print. Re-run.
   Expected: FAIL with `2b NEVER asks for video`. Restore.
2. Add `\`Your key is at ~/.gemini/api_key\`` to the generation block. Re-run.
   Expected: FAIL with `THE KEY IS NEVER IN THE PROMPT`. Restore.
3. Delete the `-i` paragraph. Re-run.
   Expected: FAIL with `generation is STRICTLY SEQUENTIAL and -i chains off the last image`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-prompt.ts dashboard/server/src/design-prompt.test.ts <<'MSG'
feat(design): the DESIGN segment prompt, copied from §7.2 rather than recalled

Every flag, the model default, the aspect set and the 2-retry cap come from the
spec and from taste-frontend-expert.md:46. -i is the load-bearing one: it holds
the palette across the set and is why generation is strictly sequential.

The key is never mentioned — the script resolves it itself, and a prompt that
named it would put it in the transcript, the build log, prompt.txt and the
canvas. The video ask is gated on the §7.1a capability flag, which is false
until gemini-video.sh exists, so nothing in 2b asks for an .mp4 that cannot be
produced.
MSG
```

---

### Task 6: The DESIGN → BUILD handoff — three mechanisms, all required

**Why:** §7.3's reason is the whole task. *"Subagents do not share context. A mockup living only in `taste-frontend-expert`'s transcript is invisible downstream."* The three mechanisms are not a menu:

1. **Filesystem** — PNGs in `design-refs/` inside the workspace, the only path `sandbox.filesystem.allowWrite: [workspace]` permits.
2. **Prompt injection** — the orchestrator reads `manifest.json` and injects **absolute image paths**, the design read, and the three dials verbatim into *each* build agent's prompt. *"Paths in a prompt are what make `Read` on a PNG actually happen."*
3. **Skill bridge** — `image-to-code`, *"turning 'here are pictures' into a mechanical implementation procedure."*

**The correction mechanism 3 needs, verified in this repo rather than assumed.** §6.3 says the skill is *preloaded* on frontend builders. **Preloading is not available.** `Options.agents` was deleted after probe I measured that a definition registered under a name that also exists in `~/.claude/agents/` is not consulted at all — and every name in `DELIVERY_LANES` exists on disk (`agent-shortlist.ts` closing comment; `api-types.ts:303-308`: *"`Options.agents` was deleted after probe I measured it not binding, so `AgentDefinition.skills` preloads nothing and `\"preloaded\"` has no producer today"*). So the bridge rides **the only channel measured to reach a child: the `prompt` argument of the Agent call**, naming the skill for the child to invoke, and it is observable as `graph_skill{source:"invoked"}`. Writing `skills: ["image-to-code"]` would compile, read correctly, and do nothing.

**Files:**
- Modify: `dashboard/server/src/design-prompt.ts` (add `designHandoffSection`)
- Modify: `dashboard/server/src/design-prompt.test.ts`

**Interfaces:**
- Consumes: `DesignManifest` (Task 1), `DesignLaneMode` (Task 4).
- Produces:
```ts
export const IMAGE_TO_CODE_SKILL = "image-to-code";
export function designHandoffSection(input: {
  manifest: DesignManifest | null;
  mode: DesignLaneMode;
  workspace: string;
  dials: string;              // the text of direction.md, or "" when absent
}): string;
```

- [ ] **Step 1: Write the failing test**

```ts
// appended to dashboard/server/src/design-prompt.test.ts
import { designHandoffSection, IMAGE_TO_CODE_SKILL } from "./design-prompt.js";
import type { DesignManifest } from "./design-manifest.js";

const HERO = `${WS}/design-refs/01-hero.png`;
const WORK = `${WS}/design-refs/02-work.png`;

const LOCKED: DesignManifest = {
  version: 1,
  refs: [
    { path: HERO, section: "hero", aspect: "21:9", intent: "full-bleed opening statement" },
    { path: WORK, section: "work", aspect: "16:9", intent: "three projects, uneven weight" },
  ],
  lockedMockup: HERO,
  lockedBy: "owner",
  lockedReason: "chosen in the dashboard",
  lockedAt: "2026-07-29T10:00:00.000Z",
};

function handoff(overrides: Partial<Parameters<typeof designHandoffSection>[0]> = {}): string {
  return designHandoffSection({
    manifest: LOCKED,
    mode: "full",
    workspace: WS,
    dials: "DESIGN_VARIANCE: high\nMOTION_INTENSITY: medium\nVISUAL_DENSITY: low",
    ...overrides,
  });
}

test("MECHANISM 1 — the filesystem location is named, and it is inside the workspace", () => {
  assert.match(handoff(), new RegExp(`${WS}/design-refs`));
});

test("MECHANISM 2 — EVERY ref appears as an ABSOLUTE path, not a count and not a directory", () => {
  // "Paths in a prompt are what make Read on a PNG actually happen" (§7.3).
  // A prompt that says "five mockups are in design-refs/" is a mechanism that
  // does not work: the child has to guess filenames.
  const p = handoff();
  assert.ok(p.includes(HERO), "the hero path is missing");
  assert.ok(p.includes(WORK), "the second path is missing");
  assert.match(p, /Read/);
});

test("MECHANISM 2 — the LOCKED mockup is marked as the one being built to", () => {
  const p = handoff();
  assert.match(p, /LOCKED/);
  const lockedLine = p.split("\n").find((line) => line.includes("LOCKED") && line.includes(HERO));
  assert.ok(lockedLine !== undefined, "the locked path is not identified on its own line");
});

test("MECHANISM 2 — the three dials are carried through VERBATIM", () => {
  const p = handoff();
  for (const dial of DESIGN_DIALS) assert.ok(p.includes(dial), `${dial} did not survive the handoff`);
  assert.match(p, /MOTION_INTENSITY: medium/);
});

test("MECHANISM 3 — the skill bridge is an INVOCATION instruction, not a preload", () => {
  // Options.agents is gone (probe I): AgentDefinition.skills preloads nothing for
  // any name that exists on disk, which is every shortlisted agent. The only
  // channel measured to reach a child is the Agent call's own prompt.
  const p = handoff();
  assert.ok(p.includes(IMAGE_TO_CODE_SKILL), "the skill is not named");
  assert.match(p, /invoke|use the .*skill/i);
});

test("ALL THREE mechanisms are present in one block — two of three is nothing", () => {
  const p = handoff();
  const present = [
    p.includes("design-refs"),
    p.includes(HERO) && p.includes(WORK),
    p.includes(IMAGE_TO_CODE_SKILL),
  ];
  assert.deepEqual(present, [true, true, true], "a handoff missing any mechanism is not a handoff");
});

test("a DEGRADED lane hands over the written direction and says there are no stills", () => {
  const p = handoff({ manifest: null, mode: "degraded" });
  assert.match(p, /direction\.md/);
  assert.match(p, /no (design )?stills/i);
  assert.doesNotMatch(p, /\.png/);
});

test("an OFF lane produces an EMPTY handoff — never a paragraph about images that do not exist", () => {
  assert.equal(handoff({ manifest: null, mode: "off", dials: "" }), "");
});

test("an unlocked manifest still hands over every path, and says nothing is locked", () => {
  const unlocked: DesignManifest = { ...LOCKED, lockedMockup: null, lockedBy: null, lockedReason: null, lockedAt: null };
  const p = handoff({ manifest: unlocked });
  assert.ok(p.includes(HERO));
  assert.match(p, /no mockup (is |was )?locked/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2305: Module './design-prompt.js' has no exported member 'designHandoffSection'.`

- [ ] **Step 3: Implement** — append to `design-prompt.ts`

```ts
/**
 * The skill that turns "here are pictures" into a mechanical implementation
 * procedure (spec §7.3 mechanism 3).
 *
 * NAMED FOR INVOCATION, NOT PRELOADED, AND THAT IS A MEASURED CONSTRAINT RATHER
 * THAN A PREFERENCE. §6.3 says "preloaded on frontend builders", but
 * `Options.agents` no longer exists: probe I measured that an `AgentDefinition`
 * registered under a name that also exists in ~/.claude/agents/ is not consulted
 * at all, and every name in DELIVERY_LANES exists on disk. So
 * `AgentDefinition.skills` preloads nothing (api-types.ts:303-308 says exactly
 * this, which is why `graph_skill.source: "preloaded"` has no producer today).
 * The only channel measured to reach a child is the Agent call's own `prompt`.
 *
 * `image-to-code` is the SKILL.md `name:`; the directory is
 * `image-to-code-skill`. §6.3's correction records that the SDK accepts either,
 * so the canonical name is used here.
 */
export const IMAGE_TO_CODE_SKILL = "image-to-code";

/**
 * The block the orchestrator injects into EVERY build agent's prompt.
 *
 * ALL THREE OF §7.3's MECHANISMS OR NONE OF THEM. Subagents do not share
 * context: a mockup living only in the designer's transcript is invisible
 * downstream, so the filesystem location, every absolute path, and the skill that
 * knows what to do with them all have to cross this seam together. Ship two and
 * the third's absence is silent — the build simply looks like it ignored the
 * design.
 */
export function designHandoffSection(input: {
  manifest: DesignManifest | null;
  mode: DesignLaneMode;
  workspace: string;
  dials: string;
}): string {
  if (input.mode === "off") return "";
  const refsDir = refsDirFor(input.workspace);

  if (input.mode === "degraded" || input.manifest === null || input.manifest.refs.length === 0) {
    const degraded: string[] = [
      "THE DESIGN LANE PRODUCED NO STILLS on this run — image generation was",
      "unavailable. It produced written art direction instead:",
      "",
      `  Read ${join(refsDir, "direction.md")}`,
      "",
      "Build to that document. It is the only design input this run has, so it is the",
      "one the visual gate will read your work against.",
    ];
    if (input.dials.length > 0) degraded.push("", input.dials);
    return degraded.join("\n");
  }

  const lines: string[] = [
    "THE DESIGN IS ALREADY MADE. Build to it; do not re-invent it.",
    "",
    `  Mockups live in ${refsDir}/ — inside this workspace, which is the only`,
    "  directory anything here may write to.",
    "",
    "Read each of these. They render visually to you; they are not filenames to",
    "guess at:",
    "",
  ];
  for (const ref of input.manifest.refs) {
    const locked = ref.path === input.manifest.lockedMockup;
    lines.push(
      `  ${locked ? "LOCKED  " : "        "}${ref.path}` +
        `   [${ref.section}, ${ref.aspect}] ${ref.intent}`,
    );
  }
  lines.push("");
  lines.push(
    input.manifest.lockedMockup === null
      ? "No mockup is locked on this run, so the set as a whole is the reference."
      : `The LOCKED mockup is the design that was chosen: ${input.manifest.lockedMockup}. ` +
        `Resembling a different one from the set is not a pass.`,
    "",
    `Invoke the \`${IMAGE_TO_CODE_SKILL}\` skill before you write markup. It is the`,
    "procedure for turning these images into an implementation — read the images",
    "deeply first, then build to them section by section.",
    "",
  );
  if (input.dials.length > 0) {
    lines.push("THE DIALS THE DESIGN WAS SET TO. Build to these values:", "", input.dials, "");
  }
  return lines.join("\n");
}
```

Add the imports it needs at the top of the file: `import type { DesignManifest } from "./design-manifest.js";`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 9 further tests in `design-prompt.test.js`.

- [ ] **Step 5: Negative control — remove each mechanism in turn**

This is the step that makes "all three are required" more than a sentence.

1. Replace the per-ref loop with a single line `  Five mockups are in ${refsDir}/`. Re-run.
   Expected: FAIL with `MECHANISM 2 — EVERY ref appears as an ABSOLUTE path` **and** `ALL THREE mechanisms are present in one block`. Restore.
2. Delete the `Invoke the \`image-to-code\` skill` paragraph. Re-run.
   Expected: FAIL with `MECHANISM 3 — the skill bridge is an INVOCATION instruction` **and** `ALL THREE…`. Restore.
3. Drop `input.dials` from the returned block. Re-run.
   Expected: FAIL with `MECHANISM 2 — the three dials are carried through VERBATIM`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-prompt.ts dashboard/server/src/design-prompt.test.ts <<'MSG'
feat(design): the DESIGN -> BUILD handoff, all three mechanisms

Subagents do not share context, so a mockup living only in the designer's
transcript is invisible downstream (spec §7.3). The filesystem location, every
absolute image path and the image-to-code bridge cross the seam together; the
test fails if any one of them is removed.

The skill bridge is an INVOCATION instruction rather than a preload, and that is
measured rather than preferred: Options.agents is gone after probe I, so
AgentDefinition.skills preloads nothing for any name that exists on disk — which
is every shortlisted agent. `skills: ["image-to-code"]` would have compiled, read
correctly and done nothing.
MSG
```

---

### Task 7: THE TRAP — zero images is a loud, named failure

**This is the task the phase exists to get right.** Read "THE TRAP" at the top of this plan before writing a line of it. A lane that ran, wrote nothing and reported no error is the default behaviour of this chain, not an edge case.

**Files:**
- Create: `dashboard/server/src/design-outcome.ts`
- Create: `dashboard/server/src/design-outcome.test.ts`
- Modify: `dashboard/server/src/design-capability.ts` (add the script-path override the negative control needs)

**Interfaces:**
- Consumes: `DesignManifest` (Task 1), `DesignLaneMode` (Task 4), `DesignPreflight` (Task 2), `MIN_DESIGN_REFS` (Task 5).
- Produces:
```ts
export const DESIGN_SCRIPT_ENV = "DASHBOARD_GEMINI_IMAGE_SCRIPT";   // added to design-capability.ts
export type DesignFailure = "no-images" | "too-few-images" | "no-manifest" | "manifest-invalid";
export interface DesignLaneRecord {
  readonly mode: DesignLaneMode;
  readonly images: number;
  /** Generations ATTEMPTED, retries included. A count, never a dollar figure. */
  readonly imageCalls: number;
  readonly imageModel: string;
  readonly keySource: string | null;
  readonly preflight: readonly PreflightCheck[];
  readonly degradeReason: string | null;
  readonly failure: DesignFailure | null;
  readonly detail: string;
  readonly locked: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly lockedReason: string | null;
}
export function classifyDesignLane(input: {
  mode: DesignLaneMode;
  manifest: DesignManifest | null;
  pngCount: number;
  imageCalls: number;
  keySource: string | null;
  preflight: readonly PreflightCheck[];
}): DesignLaneRecord;
export function designLaneFailureMessage(record: DesignLaneRecord): string | null;
export function writeDesignLaneRecord(resultsDir: string, record: DesignLaneRecord): void;
export function readDesignLaneRecord(resultsDir: string): DesignLaneRecord | null;
```

**On the metered-call note (§7.5, end).** `imageCalls` is a **count**, and the field is named so nobody mistakes it for money. `gemini-image.sh` prints only the output path; the `generateContent` response carries no price; no price source exists anywhere in this program. Inventing a dollar figure for design-lane spend would be the same sin as reporting `costUsd` for a subscription build — a number that looks authoritative and is made up. So: **`costUsd` stays `null`, and design-lane spend is tracked as `imageCalls` plus `imageModel`, on its own line in its own file.** The two never merge, and there is a test that says so.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design-outcome.test.ts
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PreflightCheck } from "./design-capability.js";
import type { DesignManifest } from "./design-manifest.js";
import {
  classifyDesignLane,
  designLaneFailureMessage,
  readDesignLaneRecord,
  writeDesignLaneRecord,
} from "./design-outcome.js";

const WS = "/runs/r1/workspace";
const OK_PREFLIGHT: readonly PreflightCheck[] = [
  { id: "python3", ok: true, blocking: true, detail: "python3 is on PATH" },
];

function manifestWith(count: number): DesignManifest {
  return {
    version: 1,
    refs: Array.from({ length: count }, (_unused, index) => ({
      path: `${WS}/design-refs/0${String(index + 1)}.png`,
      section: `s${String(index + 1)}`,
      aspect: "16:9" as const,
      intent: "x",
    })),
    lockedMockup: null,
    lockedBy: null,
    lockedReason: null,
    lockedAt: null,
  };
}

function classify(over: Partial<Parameters<typeof classifyDesignLane>[0]> = {}) {
  return classifyDesignLane({
    mode: "full",
    manifest: manifestWith(5),
    pngCount: 5,
    imageCalls: 6,
    keySource: "GEMINI_API_KEY",
    preflight: OK_PREFLIGHT,
    ...over,
  });
}

test("THE TRAP: a FULL lane with zero images is a NAMED FAILURE, not a quiet success", () => {
  const record = classify({ manifest: null, pngCount: 0, imageCalls: 3 });
  assert.equal(record.failure, "no-images");
  const message = designLaneFailureMessage(record);
  assert.ok(message !== null, "a zero-image full lane MUST produce a message");
  assert.match(message, /DESIGN/);
  assert.match(message, /no images/i);
  assert.match(message, /3 generation/i, "the attempts are named — they are the evidence it tried");
});

test("THE TRAP: a DEGRADED lane with zero images is NOT a failure — and the two never collapse", () => {
  // Same file count, opposite meaning. If these ever return the same record, a
  // broken image chain becomes indistinguishable from a machine with no key.
  const degraded = classify({ mode: "degraded", manifest: null, pngCount: 0, imageCalls: 0 });
  assert.equal(degraded.failure, null);
  assert.equal(designLaneFailureMessage(degraded), null);
  assert.ok(degraded.degradeReason !== null, "a degraded lane always says WHY it degraded");

  const broken = classify({ manifest: null, pngCount: 0, imageCalls: 3 });
  assert.notEqual(degraded.failure, broken.failure);
});

test("fewer than five images is its own failure — a partial set is not a set", () => {
  const record = classify({ manifest: manifestWith(2), pngCount: 2 });
  assert.equal(record.failure, "too-few-images");
  assert.match(String(designLaneFailureMessage(record)), /2 of 5/);
});

test("images on disk with no manifest is a failure — nothing downstream can read them", () => {
  // §7.3 mechanism 2 reads manifest.json. Five PNGs no prompt names might as well
  // not exist.
  const record = classify({ manifest: null, pngCount: 5 });
  assert.equal(record.failure, "no-manifest");
});

test("a manifest that claims more refs than exist on disk is INVALID, not trusted", () => {
  const record = classify({ manifest: manifestWith(5), pngCount: 3 });
  assert.equal(record.failure, "manifest-invalid");
  assert.match(String(designLaneFailureMessage(record)), /3 file/);
});

test("an OFF lane claims nothing at all", () => {
  const record = classify({ mode: "off", manifest: null, pngCount: 0, imageCalls: 0 });
  assert.equal(record.failure, null);
  assert.equal(record.degradeReason, null);
  assert.equal(designLaneFailureMessage(record), null);
});

test("the happy path is silent", () => {
  assert.equal(classify().failure, null);
  assert.equal(designLaneFailureMessage(classify()), null);
});

test("SPEND IS A COUNT, NEVER A DOLLAR FIGURE", () => {
  // The DESIGN lane spends real money through a key read from ~/.gemini/api_key,
  // and nothing in this program knows the price. costUsd stays null for the run;
  // design spend is a call count and a model name, on its own line.
  //
  // SCOPED TO THE RECORD'S OWN KEYS, not to its serialised text: a preflight
  // detail or a degrade reason may legitimately contain the word "cost", and a
  // test that went red for that would be red for the wrong reason and get
  // loosened by whoever hit it.
  const record = classify({ imageCalls: 7 });
  assert.equal(record.imageCalls, 7);
  for (const key of Object.keys(record)) {
    assert.doesNotMatch(key, /usd|cost|dollar|price/i, `${key} looks like money`);
  }
});

test("the record carries the key SOURCE and never anything key-shaped", () => {
  const json = JSON.stringify(classify({ keySource: "~/.gemini/api_key" }));
  assert.match(json, /~\/\.gemini\/api_key/);
  assert.doesNotMatch(json, /sk-/);
});

test("the record round-trips through disk — an unattended run is explained after the fact", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-record-"));
  const record = classify({ manifest: null, pngCount: 0, imageCalls: 3 });
  writeDesignLaneRecord(dir, record);
  assert.deepEqual(readDesignLaneRecord(dir), record);
  assert.equal(readDesignLaneRecord(mkdtempSync(join(tmpdir(), "design-empty-"))), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './design-outcome.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design-outcome.ts
/**
 * design-outcome.ts — THE TRAP, and the only thing standing in front of it.
 *
 * A DESIGN LANE THAT PRODUCED ZERO IMAGES MUST NEVER LOOK SUCCESSFUL.
 *
 * `sandbox.autoAllowBashIfSandboxed: true` means Bash never reaches
 * `decideToolPermission` (claude-builder.ts:1011), so every failure in the image
 * chain — a missing python3, an unresolvable `npx impeccable`, a TMPDIR outside
 * `allowWrite`, a key that does not resolve, an API that 4xxs through the whole
 * fallback model chain — surfaces as a script error on a stream the permission
 * layer cannot see. All of them produce the same observable: no PNGs, no error,
 * a completed build.
 *
 * The only way to tell those apart from a lane that was never going to generate
 * is to have decided WHICH LANE THIS IS before it ran (design-lane.ts) and to
 * write that down here alongside what actually appeared on disk. `mode:"full"`
 * with `images:0` and `mode:"degraded"` with `images:0` are the same directory
 * listing and the opposite conclusion.
 *
 * SPEND IS A COUNT. The DESIGN lane spends real money through a key read from
 * `~/.gemini/api_key`, and nothing in this program knows the price:
 * `gemini-image.sh` prints an output path and the API response carries no cost
 * field. `costUsd` stays `null` for the run (api-types.ts's file header is the
 * contract), and design-lane spend is `imageCalls` plus `imageModel` on its own
 * line in its own file. A dollar figure invented here would be exactly the lie
 * that header exists to prevent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreflightCheck } from "./design-capability.js";
import type { DesignLaneMode } from "./design-lane.js";
import type { DesignLockedBy, DesignManifest } from "./design-manifest.js";
import { MIN_DESIGN_REFS } from "./design-prompt.js";

export const DESIGN_LANE_RECORD_FILE = "design-lane.json";

/** The default model `gemini-image.sh` uses when `-m` is not passed. */
export const DESIGN_IMAGE_MODEL = "gemini-3.1-flash-image-preview";

export type DesignFailure = "no-images" | "too-few-images" | "no-manifest" | "manifest-invalid";

export interface DesignLaneRecord {
  readonly mode: DesignLaneMode;
  readonly images: number;
  /** Generations ATTEMPTED, retries included. A COUNT. Never money. */
  readonly imageCalls: number;
  readonly imageModel: string;
  /** WHICH source resolved the key. Never a key. */
  readonly keySource: string | null;
  readonly preflight: readonly PreflightCheck[];
  readonly degradeReason: string | null;
  readonly failure: DesignFailure | null;
  readonly detail: string;
  readonly locked: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly lockedReason: string | null;
}

function degradeReasonFrom(preflight: readonly PreflightCheck[]): string {
  const failed = preflight.filter((check) => !check.ok);
  if (failed.length === 0) return "no Gemini key resolved for this run";
  return failed.map((check) => `${check.id}: ${check.detail}`).join(" | ");
}

export function classifyDesignLane(input: {
  mode: DesignLaneMode;
  manifest: DesignManifest | null;
  pngCount: number;
  imageCalls: number;
  keySource: string | null;
  preflight: readonly PreflightCheck[];
}): DesignLaneRecord {
  const base = {
    mode: input.mode,
    images: input.pngCount,
    imageCalls: input.imageCalls,
    imageModel: DESIGN_IMAGE_MODEL,
    keySource: input.keySource,
    preflight: input.preflight,
    locked: input.manifest?.lockedMockup ?? null,
    lockedBy: input.manifest?.lockedBy ?? null,
    lockedReason: input.manifest?.lockedReason ?? null,
  } as const;

  if (input.mode === "off") {
    return { ...base, degradeReason: null, failure: null, detail: "the DESIGN lane did not run" };
  }
  if (input.mode === "degraded") {
    return {
      ...base,
      degradeReason: degradeReasonFrom(input.preflight),
      failure: null,
      detail:
        "the DESIGN lane ran degraded: written art direction, no stills. The visual gate falls back " +
        "to rule-based scoring with no reference image.",
    };
  }

  // mode === "full": images were both possible and asked for.
  if (input.pngCount === 0) {
    return {
      ...base,
      degradeReason: null,
      failure: "no-images",
      detail:
        `the DESIGN lane ran in FULL mode and produced no images after ` +
        `${String(input.imageCalls)} generation attempt(s). Every failure in the image chain is ` +
        `invisible to the permission layer, so this is what it looks like: check the build log for ` +
        `gemini-image.sh stderr.`,
    };
  }
  if (input.manifest === null) {
    return {
      ...base,
      degradeReason: null,
      failure: "no-manifest",
      detail:
        `${String(input.pngCount)} image(s) exist but there is no readable manifest. Nothing ` +
        `downstream can name them, so no build agent will Read one and the visual gate has no ` +
        `reference — the images might as well not exist.`,
    };
  }
  if (input.manifest.refs.length > input.pngCount) {
    return {
      ...base,
      degradeReason: null,
      failure: "manifest-invalid",
      detail:
        `the manifest lists ${String(input.manifest.refs.length)} refs but ${String(input.pngCount)} ` +
        `file(s) exist. A path in a prompt that resolves to nothing is a Read failure inside every ` +
        `build agent.`,
    };
  }
  if (input.pngCount < MIN_DESIGN_REFS) {
    return {
      ...base,
      degradeReason: null,
      failure: "too-few-images",
      detail:
        `the DESIGN lane produced ${String(input.pngCount)} of ${String(MIN_DESIGN_REFS)} required ` +
        `images. A partial set does not cover the page, and the sections with no still get built ` +
        `from nothing.`,
    };
  }
  return {
    ...base,
    degradeReason: null,
    failure: null,
    detail: `${String(input.pngCount)} design still(s) in ${String(input.imageCalls)} generation(s)`,
  };
}

/**
 * The line the run says out loud. Null when there is nothing to say — and null
 * for a DEGRADED lane, which is expected rather than broken.
 */
export function designLaneFailureMessage(record: DesignLaneRecord): string | null {
  return record.failure === null ? null : `DESIGN LANE FAILED (${record.failure}): ${record.detail}`;
}

export function writeDesignLaneRecord(resultsDir: string, record: DesignLaneRecord): void {
  writeFileSync(join(resultsDir, DESIGN_LANE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function readDesignLaneRecord(resultsDir: string): DesignLaneRecord | null {
  const path = join(resultsDir, DESIGN_LANE_RECORD_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesignLaneRecord;
  } catch {
    return null;
  }
}
```

Add the script-path override to `design-capability.ts`, whose only purpose is to make the negative control in Step 5 runnable **without touching `~/.claude/scripts/`** — the agent body hardcodes the tilde-expanded absolute path, so a `PATH` shim cannot intercept it and overwriting the owner's real script is not an option:

```ts
/**
 * Override for the image script's location.
 *
 * EXISTS FOR THE NEGATIVE CONTROL, and that is a good enough reason. THE TRAP's
 * proof is a run with a deliberately broken image script, and the script is
 * reached by an absolute path that no PATH shim intercepts. Without this, the
 * one control that matters cannot be executed without vandalising the owner's
 * ~/.claude/scripts/.
 */
export const DESIGN_SCRIPT_ENV = "DASHBOARD_GEMINI_IMAGE_SCRIPT";

export function designScriptPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = (env[DESIGN_SCRIPT_ENV] ?? "").trim();
  return override.length > 0 ? override : expandHome(GEMINI_IMAGE_SCRIPT, homeDir);
}
```

and pass it from `detectDesignCapability`'s caller in the orchestrator.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 10 tests in `design-outcome.test.js`.

- [ ] **Step 5: THE NEGATIVE CONTROL — run the lane with the image script deliberately broken**

Mandatory, not advisory. Without it, every claim in this task is a test agreeing with itself.

```bash
cd dashboard/server
mkdir -p /tmp/design-nc && cat > /tmp/design-nc/broken-gemini.sh <<'SH'
#!/usr/bin/env bash
echo "gemini-image: simulated failure — no API key" >&2
exit 1
SH
chmod +x /tmp/design-nc/broken-gemini.sh

DASHBOARD_GEMINI_IMAGE_SCRIPT=/tmp/design-nc/broken-gemini.sh \
GEMINI_API_KEY=stub-key-not-used-by-the-stub \
node --test "dist-2b/**/design-outcome.test.js"
```

Then run one real ticket end to end against the stub (a `web-ui` ticket, so the lane is `full`), with the same two variables set, and assert **all four** of these — a lane that fails must be loud in every place a person looks:

| Where | What must be there |
|---|---|
| `runs/<id>/results/design-lane.json` | `"failure": "no-images"`, `"imageCalls"` > 0 |
| the run's event stream | a `log` event at level `error` containing `DESIGN LANE FAILED (no-images)` |
| `RunDetail.designLock` | `null` locked path — never a fabricated one |
| the build log | `gemini-image: simulated failure` (the script's own stderr, preserved) |

**And run the positive arm too**, with the stub replaced by a script that writes five 1×1 PNGs and a valid manifest: `design-lane.json` must carry `"failure": null` and `"images": 5`. Without that arm, "the lane reported a failure" could simply mean the detector reports a failure for everything.

Record both arms' `design-lane.json` verbatim in the phase result. If the failure arm is quiet in **any** of the four places, this task is not done.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-outcome.ts dashboard/server/src/design-outcome.test.ts dashboard/server/src/design-capability.ts <<'MSG'
feat(design): a DESIGN lane that produced zero images fails loudly

autoAllowBashIfSandboxed means Bash never reaches decideToolPermission, so every
failure in the image chain — missing python3, unresolvable npx impeccable, a
TMPDIR outside allowWrite, an unresolvable key — surfaces as a script error the
host cannot see, and all of them look identical: a lane that ran, wrote nothing
and reported no error.

The lane's MODE is decided before it runs, so full-with-zero-images and
degraded-with-zero-images stay distinguishable. The first is a named failure with
the attempt count as evidence; the second is expected and says why.

Design-lane spend is a call count and a model name. Nothing here knows a price,
costUsd stays null, and a field that looked like money would be the same
invented number that file header exists to prevent.
MSG
```

---

### Task 8: The design lock — §17.3's five rules, as five testable behaviours

**Why:** §17.2 is the argument. Today's visual gate compares the built site against *five* mockups — against which one? A locked reference turns a vague comparison into a precise one. **The lock-in feature is a grader improvement disguised as a UI feature**, which is why it lives in this phase and not in a UI phase.

§17.3's rules, and where each one lands:

| Rule | Lands as |
|---|---|
| 1. Never blocks indefinitely — `DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN`, auto-select on timeout and record it was automatic | `designLockTimeoutMin` + `designLockExpired` here; the timer in Task 9 |
| 2. Cron runs auto-select by default — `designLock: "auto" \| "ask"`, defaulting to `auto` when the request is not interactive | `designLockPolicy` here; the request field in Task 10 |
| 3. The auto-chooser is `ui-designer`, not `taste-frontend-expert` | `readChoiceFile` + the Task 5 prompt; asserted here |
| 4. The choice is recorded either way, with who made it and why | `lockManifest` requires a `by` and a `reason` — neither is optional |
| 5. A locked design is an input to the gate, recorded in the run record | `writeDesignLock` beside the run record; Task 10 surfaces it |

**Files:**
- Create: `dashboard/server/src/design-lock.ts`
- Create: `dashboard/server/src/design-lock.test.ts`

**Interfaces:**
- Consumes: `DesignManifest`, `DesignLockedBy`, `serialiseDesignManifest` (Task 1); `DESIGN_CHOICE_FILE` (Task 5).
- Produces:
```ts
export type DesignLockPolicy = "auto" | "ask";
export const DESIGN_LOCK_TIMEOUT_ENV = "DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN";
export const DEFAULT_DESIGN_LOCK_TIMEOUT_MIN = 30;
export function designLockPolicy(requested: unknown, interactive: boolean): DesignLockPolicy;
export function designLockTimeoutMin(env: NodeJS.ProcessEnv): number;
export function designLockExpired(parkedAt: string, now: string, timeoutMin: number): boolean;
export interface LockAttempt {
  readonly path: string;
  readonly by: DesignLockedBy;
  readonly reason: string;
  readonly at: string;
}
export type LockResult =
  | { readonly ok: true; readonly manifest: DesignManifest }
  | { readonly ok: false; readonly error: string };
export function lockManifest(manifest: DesignManifest, attempt: LockAttempt): LockResult;
export function readChoiceFile(refsDir: string, manifest: DesignManifest, at: string): LockAttempt | null;
export function fallbackChoice(manifest: DesignManifest, at: string, why: string): LockAttempt | null;
/** §17.3 rule 5 — the lock, recorded beside the run record. */
export const DESIGN_MOCKUP_LABEL = "design mockup — ";
export interface DesignLockRecord {
  readonly awaiting: boolean;
  readonly parkedAt: string;
  readonly locked: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly reason: string | null;
}
export function writeDesignLock(resultsDir: string, record: DesignLockRecord): void;
export function readDesignLock(resultsDir: string): DesignLockRecord | null;
```

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/design-lock.test.ts
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DesignManifest } from "./design-manifest.js";
import {
  DEFAULT_DESIGN_LOCK_TIMEOUT_MIN,
  designLockExpired,
  designLockPolicy,
  designLockTimeoutMin,
  fallbackChoice,
  lockManifest,
  readChoiceFile,
  readDesignLock,
  writeDesignLock,
} from "./design-lock.js";

const WS = "/runs/r1/workspace";
const A = `${WS}/design-refs/01-hero.png`;
const B = `${WS}/design-refs/02-work.png`;
const AT = "2026-07-29T10:00:00.000Z";

const MANIFEST: DesignManifest = {
  version: 1,
  refs: [
    { path: A, section: "hero", aspect: "21:9", intent: "opening" },
    { path: B, section: "work", aspect: "16:9", intent: "projects" },
  ],
  lockedMockup: null,
  lockedBy: null,
  lockedReason: null,
  lockedAt: null,
};

test("RULE 2: a non-interactive request defaults to auto — a cron run never parks", () => {
  // "A scheduled run that parks forever waiting for a click is the exact failure
  // unattended operation exists to avoid."
  assert.equal(designLockPolicy(undefined, false), "auto");
  assert.equal(designLockPolicy(null, false), "auto");
  assert.equal(designLockPolicy("ask", false), "ask", "an EXPLICIT ask is still honoured");
  assert.equal(designLockPolicy(undefined, true), "ask", "an interactive request may pause");
  assert.equal(designLockPolicy("nonsense", false), "auto", "an unknown value is not an error, it is auto");
});

test("RULE 1: the timeout is finite, configurable, and never zero or infinite", () => {
  assert.equal(designLockTimeoutMin({}), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "5" }), 5);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "-1" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
  assert.equal(designLockTimeoutMin({ DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "nope" }), DEFAULT_DESIGN_LOCK_TIMEOUT_MIN);
});

test("RULE 1: expiry is computed from the park time, so a server restart cannot make a park infinite", () => {
  assert.equal(designLockExpired(AT, "2026-07-29T10:29:00.000Z", 30), false);
  assert.equal(designLockExpired(AT, "2026-07-29T10:31:00.000Z", 30), true);
  assert.equal(designLockExpired("not a date", "2026-07-29T10:31:00.000Z", 30), true, "an unreadable park time expires");
});

test("RULE 4: a lock without a chooser and a reason cannot be constructed", () => {
  const locked = lockManifest(MANIFEST, { path: A, by: "owner", reason: "the type is doing the work", at: AT });
  assert.equal(locked.ok, true);
  assert.ok(locked.ok && locked.manifest.lockedMockup === A);
  assert.ok(locked.ok && locked.manifest.lockedBy === "owner");
  assert.ok(locked.ok && locked.manifest.lockedReason === "the type is doing the work");
  assert.ok(locked.ok && locked.manifest.lockedAt === AT);

  const empty = lockManifest(MANIFEST, { path: A, by: "owner", reason: "   ", at: AT });
  assert.equal(empty.ok, false, "an unattended run must be explainable after the fact");
});

test("a chosen path that is not one of the refs is REFUSED", () => {
  // The path arrives from an HTTP body and from an agent-written file. Either
  // could name ~/.gemini/api_key, and the locked path is injected into every
  // build prompt and Read by the visual gate.
  const forged = lockManifest(MANIFEST, { path: `${WS}/design-refs/99.png`, by: "owner", reason: "x", at: AT });
  assert.equal(forged.ok, false);
  assert.match(String(!forged.ok && forged.error), /not one of/i);
  assert.equal(lockManifest(MANIFEST, { path: "/etc/passwd", by: "owner", reason: "x", at: AT }).ok, false);
});

test("locking twice is refused — a run has one chosen design", () => {
  const first = lockManifest(MANIFEST, { path: A, by: "owner", reason: "x", at: AT });
  assert.ok(first.ok);
  const second = lockManifest(first.manifest, { path: B, by: "ui-designer", reason: "y", at: AT });
  assert.equal(second.ok, false, "the gate would then grade against a reference the build never saw");
});

test("RULE 3: the choice file is read as ui-designer's, and validated against the manifest", () => {
  const refsDir = mkdtempSync(join(tmpdir(), "design-choice-"));
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, "choice.json"), JSON.stringify({ chosen: B, reason: "denser grid" }), "utf8");
  const attempt = readChoiceFile(refsDir, MANIFEST, AT);
  assert.equal(attempt?.path, B);
  assert.equal(attempt?.by, "ui-designer");
  assert.match(String(attempt?.reason), /denser grid/);
});

test("RULE 3: a choice file naming a path outside the manifest yields NO attempt", () => {
  const refsDir = mkdtempSync(join(tmpdir(), "design-choice-bad-"));
  writeFileSync(join(refsDir, "choice.json"), JSON.stringify({ chosen: "/etc/passwd", reason: "x" }), "utf8");
  assert.equal(readChoiceFile(refsDir, MANIFEST, AT), null);
});

test("RULE 5: the lock record round-trips, and a park's clock is on DISK", () => {
  // The timeout has to survive a dashboard restart, and a timer does not. The
  // park time is written down so `reconcileOnBoot` can ask how long it has been.
  const dir = mkdtempSync(join(tmpdir(), "design-lock-"));
  const record = { awaiting: true, parkedAt: AT, locked: null, lockedBy: null, reason: null } as const;
  writeDesignLock(dir, record);
  assert.deepEqual(readDesignLock(dir), record);
  assert.equal(readDesignLock(mkdtempSync(join(tmpdir(), "design-lock-empty-"))), null);
});

test("RULE 4: when the chooser produced nothing, the fallback is RECORDED AS a fallback", () => {
  // Recording it as "ui-designer" would be a lie about provenance; recording
  // nothing would leave an unattended run unexplainable.
  const attempt = fallbackChoice(MANIFEST, AT, "ui-designer wrote no choice.json");
  assert.equal(attempt?.by, "fallback");
  assert.equal(attempt?.path, A, "first by manifest order, stated rather than dressed up as a judgement");
  assert.match(String(attempt?.reason), /wrote no choice\.json/);
  assert.equal(fallbackChoice({ ...MANIFEST, refs: [] }, AT, "x"), null, "no refs, no lock — never an invented one");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './design-lock.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/design-lock.ts
/**
 * design-lock.ts — the one place a human pause is worth it, bounded so it never
 * costs an unattended run.
 *
 * WHY THIS IS A GRADER FEATURE AND NOT A UI FEATURE (spec §17.2). The visual gate
 * compares the built site against the design — but against WHICH of five? A
 * locked reference turns "does this resemble something we generated" into "does
 * this match the design that was CHOSEN". `visual-criteria.ts` already grades
 * against `lockedMockup` and falls back to the rule-based floor when it is null;
 * this file is what makes it non-null.
 *
 * EVERY VALIDATION HERE GUARDS THE SAME SEAM: the locked path arrives either from
 * an HTTP body or from a file an agent wrote, and it is then injected into every
 * build agent's prompt and `Read` by the visual gate. An unvalidated path there
 * is a file-read primitive. It must be one of the manifest's own refs, or there
 * is no lock.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignLockedBy, DesignManifest } from "./design-manifest.js";
import { DESIGN_CHOICE_FILE } from "./design-prompt.js";

export type DesignLockPolicy = "auto" | "ask";

export const DESIGN_LOCK_TIMEOUT_ENV = "DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN";

/**
 * Spec §17.3 rule 1 says "pick a sane finite value, not infinity". Thirty
 * minutes: long enough for an owner who stepped away from the dashboard, short
 * enough that a forgotten run still finishes within the hour.
 */
export const DEFAULT_DESIGN_LOCK_TIMEOUT_MIN = 30;

/**
 * §17.3 rule 2. `auto` when the request is not interactive — a cron run that
 * parks forever waiting for a click is the exact failure unattended operation
 * exists to avoid. An UNRECOGNISED value is `auto` rather than an error, on the
 * same principle: the safe direction is the one that finishes.
 */
export function designLockPolicy(requested: unknown, interactive: boolean): DesignLockPolicy {
  if (requested === "ask") return "ask";
  if (requested === "auto") return "auto";
  return interactive ? "ask" : "auto";
}

export function designLockTimeoutMin(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseFloat((env[DESIGN_LOCK_TIMEOUT_ENV] ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DESIGN_LOCK_TIMEOUT_MIN;
}

/**
 * Computed from the PARK TIME rather than from a live timer, so a dashboard
 * restart during a park does not reset the clock — `reconcileOnBoot` asks this
 * and finishes an expired park instead of leaving it forever.
 */
export function designLockExpired(parkedAt: string, now: string, timeoutMin: number): boolean {
  const parked = Date.parse(parkedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(parked) || !Number.isFinite(at)) return true;
  return at - parked >= timeoutMin * 60_000;
}

export interface LockAttempt {
  readonly path: string;
  readonly by: DesignLockedBy;
  readonly reason: string;
  readonly at: string;
}

export type LockResult =
  | { readonly ok: true; readonly manifest: DesignManifest }
  | { readonly ok: false; readonly error: string };

/**
 * §17.3 rule 4: the choice is recorded either way, with who made it and why. A
 * blank reason is refused rather than defaulted, because the whole value of the
 * record is that it explains an unattended run after the fact.
 */
export function lockManifest(manifest: DesignManifest, attempt: LockAttempt): LockResult {
  if (manifest.lockedMockup !== null) {
    return {
      ok: false,
      error: `this run already locked ${manifest.lockedMockup}; a second lock would let the gate grade ` +
        `against a reference the build never saw`,
    };
  }
  if (!manifest.refs.some((ref) => ref.path === attempt.path)) {
    return { ok: false, error: `${attempt.path} is not one of this run's ${String(manifest.refs.length)} mockups` };
  }
  if (attempt.reason.trim().length === 0) {
    return { ok: false, error: "a lock needs a reason: an unattended run has to be explainable afterwards" };
  }
  return {
    ok: true,
    manifest: {
      ...manifest,
      lockedMockup: attempt.path,
      lockedBy: attempt.by,
      lockedReason: attempt.reason.trim(),
      lockedAt: attempt.at,
    },
  };
}

/**
 * §17.3 rule 3: the auto-chooser is `ui-designer`, not the author. The prompt
 * asks `ui-designer` to write this file; the HOST reads it and applies the lock,
 * so the provenance recorded is the provenance the host observed rather than a
 * field an agent filled in about itself.
 */
export function readChoiceFile(refsDir: string, manifest: DesignManifest, at: string): LockAttempt | null {
  const path = join(refsDir, DESIGN_CHOICE_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const chosen = record["chosen"];
  const reason = record["reason"];
  if (typeof chosen !== "string" || !manifest.refs.some((ref) => ref.path === chosen)) return null;
  const text = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "no reason given";
  return { path: chosen, by: "ui-designer", reason: text, at };
}

/**
 * The last resort, named as such.
 *
 * `by: "fallback"` is deliberately NOT one of §17.3's two choosers: recording an
 * arbitrary pick as `ui-designer` would be a lie about provenance, and recording
 * nothing would leave the gate with no reference on a run that had five mockups.
 * First by manifest order, said plainly rather than dressed up as a judgement.
 */
export function fallbackChoice(manifest: DesignManifest, at: string, why: string): LockAttempt | null {
  const first = manifest.refs[0];
  if (first === undefined) return null;
  return {
    path: first.path,
    by: "fallback",
    reason: `${why}; the first mockup in manifest order was locked automatically, with no judgement applied`,
    at,
  };
}

/* ---- the record beside the run record --------------------------------- */

/**
 * ONE DEFINITION OF THE LABEL. `#recordDesignMockups` writes it onto each
 * screenshot and `toDetail` filters on it; typing the string twice is how the
 * owner's mockup cards quietly become empty six months from now.
 */
export const DESIGN_MOCKUP_LABEL = "design mockup — ";

export const DESIGN_LOCK_RECORD_FILE = "design-lock.json";

/**
 * §17.3 rule 5: "A locked design is an input to the gate, so it is recorded in
 * the run record alongside the ticket."
 *
 * IN ITS OWN FILE, FOR THE REASON `writeEnvironmentRecord` IS: `RunRecord` is a
 * bake-off contract type and `bakeoff/` is not ours to modify, so a field cannot
 * be added to it. The two are read together.
 *
 * `parkedAt` is what makes the timeout survive a restart — the park's clock is
 * on disk, not in a timer.
 */
export interface DesignLockRecord {
  readonly awaiting: boolean;
  readonly parkedAt: string;
  readonly locked: string | null;
  readonly lockedBy: DesignLockedBy | null;
  readonly reason: string | null;
}

export function writeDesignLock(resultsDir: string, record: DesignLockRecord): void {
  writeFileSync(join(resultsDir, DESIGN_LOCK_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function readDesignLock(resultsDir: string): DesignLockRecord | null {
  const path = join(resultsDir, DESIGN_LOCK_RECORD_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesignLockRecord;
  } catch {
    return null;
  }
}
```

The import line grows to `import { existsSync, readFileSync, writeFileSync } from "node:fs";`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 9 tests in `design-lock.test.js`.

- [ ] **Step 5: Negative control**

1. Change `designLockPolicy`'s final line to `return "ask";`. Re-run.
   Expected: FAIL with `RULE 2: a non-interactive request defaults to auto`. Restore. *(This is the mutation that would make every cron run park forever.)*
2. Delete the `refs.some(...)` check in `lockManifest`. Re-run.
   Expected: FAIL with `a chosen path that is not one of the refs is REFUSED`. Restore.
3. Change `fallbackChoice`'s `by` to `"ui-designer"`. Re-run.
   Expected: FAIL with `RULE 4: when the chooser produced nothing, the fallback is RECORDED AS a fallback`. Restore.
4. Make `designLockTimeoutMin` return `Number.POSITIVE_INFINITY` when unset. Re-run.
   Expected: FAIL with `RULE 1: the timeout is finite`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-lock.ts dashboard/server/src/design-lock.test.ts <<'MSG'
feat(design): the design lock — §17.3's five rules as five behaviours

A locked reference is what turns the visual gate's question from "does this
resemble something we generated" into "does this match the design that was
chosen", so the lock is a grader improvement wearing a UI feature's clothes.

Bounded in both directions: a non-interactive request defaults to auto so a cron
run never parks, and expiry is computed from the park time so a dashboard
restart cannot make a park infinite. Every locked path is validated against the
manifest's own refs — it arrives from an HTTP body or an agent-written file and
is then injected into every build prompt and Read by the gate.

A fallback pick is recorded as "fallback", never as ui-designer: an arbitrary
choice wearing the chooser's name is a lie about provenance.
MSG
```

---

### Task 9: Two segments, one session — the pure half

**The execution model, and why it is not the alternative §6.1 rejected.** The build phase becomes **two `builder.build()` calls that share ONE session**: segment 2 passes segment 1's `session_id` as `resumeSessionId`, exactly as the rate-limit resume path already does. §6.1 rejected *"N separate `query()` calls, one per lane"* because it *"produces zero real edges: `parent_tool_use_id` is `null` at the top level of every separate session"* and *"yields N `session_id` values against a `sessionId: string | null` field that the rate-limit resume path depends on."* Neither applies here: there is one session, one `session_id`, and every `parent_tool_use_id` inside it is real.

**What makes the boundary deterministic:** segment 1 runs with `allowedAgents` = SPEC + DESIGN lanes only. The `PreToolUse` delegation hook — the slot probe A measured the engine actually asks — denies every BUILD-lane `subagent_type`. The sequencing is therefore enforced by the guard that already exists, not by the model choosing to stop.

**Note on two things that sound alike:** the dashboard's `spec` **phase** (freezing the acceptance suite, `#specPhase`) is not the SPEC **lane** (`context-manager` → `product-manager` → …). Segment 1 includes the SPEC *lane* because `context-manager` "runs this one first; it owns the context the later lanes read" (`build-prompt.ts:173`) — a DESIGN lane art-directing with no context gathering is a worse lane. **`ApiPhase` is not widened**: both segments run inside the existing `build` phase.

**And the trap this task exists to close.** `GraphProjection` mints node ids per **build call** — `#next = 1` — and its own docblock says *"A resumed build gets a fresh one and mints from `n1` again, which is why `foldGraph` IGNORES a repeated node id rather than overwriting."* That protects the root and nothing else: segment 2's `n2` is a *different agent* from segment 1's `n2`, `foldGraph` drops the second `graph_agent`, and every subsequent `graph_tool{node:"n2"}` from segment 2 lands on the DESIGN agent's node. The canvas renders, nothing errors, and a `nextjs-developer`'s tool pills appear under `taste-frontend-expert`. That is `api-types.ts:194-202`'s "MERGE INTO ONE NODE, silently" arriving by a different road.

**Files:**
- Create: `dashboard/server/src/build-segment.ts`
- Create: `dashboard/server/src/build-segment.test.ts`

**Interfaces:**
- Consumes: `GraphSseEvent` from `./api-types.js`; `DesignLaneMode` (Task 4).
- Produces:
```ts
export type BuildSegment = "design" | "design-resume" | "build" | "build-resume";
export function nextBuildSegment(input: {
  laneMode: DesignLaneMode;
  manifestExists: boolean;
  manifestLocked: boolean;
  sessionId: string | null;
  designSegmentDone: boolean;
}): BuildSegment;
export interface GraphResumeState { readonly rootNode: string | null; readonly minted: number; }
export function graphResumeState(events: readonly GraphSseEvent[]): GraphResumeState;
export function makeSegmentRemap(base: GraphResumeState): (event: GraphSseEvent) => GraphSseEvent;
```

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/server/src/build-segment.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GraphSseEvent } from "./api-types.js";
import { graphResumeState, makeSegmentRemap, nextBuildSegment } from "./build-segment.js";

function segment(over: Partial<Parameters<typeof nextBuildSegment>[0]> = {}) {
  return nextBuildSegment({
    laneMode: "full",
    manifestExists: false,
    manifestLocked: false,
    sessionId: null,
    designSegmentDone: false,
    ...over,
  });
}

test("a fresh visual run starts in the DESIGN segment", () => {
  assert.equal(segment(), "design");
});

test("a run with no DESIGN lane goes straight to BUILD", () => {
  assert.equal(segment({ laneMode: "off" }), "build");
});

test("a LOCKED manifest means the design segment is finished — build next", () => {
  assert.equal(segment({ sessionId: "s1", manifestExists: true, manifestLocked: true }), "build-resume");
});

test("THE TRAP IN THIS TASK: an interrupted DESIGN segment resumes as DESIGN, not as BUILD", () => {
  // `resuming = row.builderSessionId !== null` (orchestrator.ts:593) is TRUE for
  // both a rate-limited design segment and a post-lock build segment. Reading
  // only that flag sends `resumeBuilderPrompt("the dashboard was interrupted")`,
  // which names no locked mockup — §7.3 mechanism 2 then fails with nothing
  // reporting it, and the build looks successful.
  assert.equal(
    segment({ sessionId: "s1", manifestExists: false, manifestLocked: false, designSegmentDone: false }),
    "design-resume",
  );
  assert.equal(
    segment({ sessionId: "s1", manifestExists: true, manifestLocked: false, designSegmentDone: false }),
    "design-resume",
    "a manifest with no lock is still an unfinished design segment",
  );
});

test("a degraded lane still runs a DESIGN segment — written direction is design work", () => {
  assert.equal(segment({ laneMode: "degraded" }), "design");
  assert.equal(
    segment({ laneMode: "degraded", sessionId: "s1", designSegmentDone: true }),
    "build-resume",
    "and it hands over without a lock, because there is nothing to lock",
  );
});

/* ---- node identity across the two segments ---------------------------- */

function agentEvent(node: string, parent: string | null, agent: string): GraphSseEvent {
  return {
    type: "graph_agent",
    node,
    parent,
    agent,
    lane: null,
    description: "d",
    ambient: false,
    attribution: "exact",
    sdk: null,
  };
}

function toolEvent(node: string, name: string): GraphSseEvent {
  return { type: "graph_tool", node, name, mcpServer: null, summary: "s", attribution: "exact" };
}

const SEGMENT_ONE: readonly GraphSseEvent[] = [
  agentEvent("n1", null, "orchestrator"),
  agentEvent("n2", "n1", "taste-frontend-expert"),
  toolEvent("n2", "Bash"),
  agentEvent("n3", "n1", "ui-designer"),
];

test("graphResumeState finds the root and the high-water mark", () => {
  const state = graphResumeState(SEGMENT_ONE);
  assert.equal(state.rootNode, "n1");
  assert.equal(state.minted, 3);
});

test("SEGMENT 2's NODES DO NOT COLLIDE WITH SEGMENT 1's", () => {
  // Without this, foldGraph drops segment 2's graph_agent for n2 and every
  // graph_tool{node:"n2"} from the build lands on taste-frontend-expert's node.
  // The canvas still renders, which is what makes it dangerous.
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const rebuilt = [
    agentEvent("n1", null, "orchestrator"),
    agentEvent("n2", "n1", "nextjs-developer"),
    toolEvent("n2", "Write"),
  ].map(remap);

  const builder = rebuilt[1] as Extract<GraphSseEvent, { type: "graph_agent" }>;
  assert.notEqual(builder.node, "n2", "the build agent must not reuse the designer's node id");
  assert.equal(builder.node, "n4");
  assert.equal((rebuilt[2] as Extract<GraphSseEvent, { type: "graph_tool" }>).node, "n4");
});

test("segment 2's ROOT maps back onto segment 1's root — one session, one root node", () => {
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const root = remap(agentEvent("n1", null, "orchestrator")) as Extract<GraphSseEvent, { type: "graph_agent" }>;
  assert.equal(root.node, "n1", "the resumed session is the SAME session, not a second one");
});

test("a parent reference inside segment 2 is remapped too — an edge to a dropped node is an edge to nothing", () => {
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const events = [agentEvent("n1", null, "orchestrator"), agentEvent("n2", "n1", "nextjs-developer")].map(remap);
  const child = events[1] as Extract<GraphSseEvent, { type: "graph_agent" }>;
  assert.equal(child.parent, "n1");
});

test("graph_inventory passes through untouched — it names no node", () => {
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const inventory: GraphSseEvent = {
    type: "graph_inventory",
    agents: 1, skills: 2, tools: 3,
    allowedAgents: ["a"], mcpServers: [], plugins: [],
    model: "m", claudeCodeVersion: "v", environmentHash: "h",
  };
  assert.deepEqual(remap(inventory), inventory);
});

test("a first segment that emitted nothing yields a remap that changes nothing", () => {
  const remap = makeSegmentRemap(graphResumeState([]));
  const event = agentEvent("n1", null, "orchestrator");
  assert.deepEqual(remap(event), event);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2307: Cannot find module './build-segment.js'`.

- [ ] **Step 3: Implement**

```ts
// dashboard/server/src/build-segment.ts
/**
 * build-segment.ts — the build phase is two calls against one session, and this
 * is the pure half of that.
 *
 * WHY TWO CALLS AND NOT ONE. Spec §17 wants the run to PARK between the design
 * and the build so an owner can pick a mockup, and `awaiting_input` +
 * `POST /api/runs/:id/resume` is the mechanism the spec names ("No new
 * machinery", §17.1). A parked run is a run whose query has ended.
 *
 * WHY IT IS NOT THE LANE-PER-QUERY MODEL §6.1 REJECTED. That was rejected because
 * separate sessions produce a null `parent_tool_use_id` at every top level ("zero
 * real edges") and N `session_id` values against a field the resume path depends
 * on. Segment 2 passes segment 1's `session_id` as `resumeSessionId`, so there is
 * ONE session, one id, and every edge inside it is real.
 *
 * WHY THE BOUNDARY IS DETERMINISTIC. Segment 1 runs with `allowedAgents` narrowed
 * to the SPEC and DESIGN lanes, so the `PreToolUse` delegation hook — the slot
 * probe A measured the engine actually asks — denies every BUILD-lane
 * `subagent_type`. Nothing depends on the model choosing to stop.
 *
 * NOTE: the dashboard's `spec` PHASE (freezing the suite) is not the SPEC LANE.
 * Segment 1 carries the lane because `context-manager` "runs this one first; it
 * owns the context the later lanes read". `ApiPhase` gains no `design` member:
 * both segments run inside `build`.
 */

import type { GraphSseEvent } from "./api-types.js";
import type { DesignLaneMode } from "./design-lane.js";

export type BuildSegment = "design" | "design-resume" | "build" | "build-resume";

/**
 * WHICH SEGMENT RUNS NEXT — and the reason this is a function with a test rather
 * than an `if` in the orchestrator.
 *
 * `resuming = row.builderSessionId !== null` (orchestrator.ts:593) is TRUE in
 * four different situations that need three different prompts: a fresh run, a
 * design segment interrupted by a rate limit, a design segment finished and
 * waiting on the lock, and a build segment interrupted. Reading the session id
 * alone sends `resumeBuilderPrompt("the dashboard was interrupted")` — a prompt
 * that names no locked mockup — and §7.3's prompt-injection mechanism then fails
 * with nothing reporting it. The build still produces a page. It just ignores the
 * design.
 */
export function nextBuildSegment(input: {
  laneMode: DesignLaneMode;
  manifestExists: boolean;
  manifestLocked: boolean;
  sessionId: string | null;
  /** The design segment returned of its own accord (not cancelled, not rate-limited). */
  designSegmentDone: boolean;
}): BuildSegment {
  if (input.laneMode === "off") return input.sessionId === null ? "build" : "build-resume";
  const designFinished = input.manifestLocked || input.designSegmentDone;
  if (!designFinished) return input.sessionId === null ? "design" : "design-resume";
  return input.sessionId === null ? "build" : "build-resume";
}

export interface GraphResumeState {
  readonly rootNode: string | null;
  /** How many node ids the previous segment minted. */
  readonly minted: number;
}

const NODE_ID = /^n(\d+)$/u;

/**
 * What the next segment needs in order not to collide with this one.
 *
 * Derived from the events the orchestrator already sees on the `graph` sink, so
 * nothing new has to be persisted and `graph-emit.ts` is not touched — it belongs
 * to the canvas phase and is another agent's territory.
 */
export function graphResumeState(events: readonly GraphSseEvent[]): GraphResumeState {
  let rootNode: string | null = null;
  let minted = 0;
  for (const event of events) {
    if (event.type === "graph_inventory") continue;
    const match = NODE_ID.exec(event.node);
    if (match !== null) minted = Math.max(minted, Number.parseInt(match[1] ?? "0", 10));
    if (event.type === "graph_agent" && event.parent === null && rootNode === null) rootNode = event.node;
  }
  return { rootNode, minted };
}

/**
 * Rewrite a resumed segment's node ids so they extend the run's graph instead of
 * overwriting it.
 *
 * THE FAILURE THIS PREVENTS IS SILENT. `GraphProjection` mints from `n1` per
 * BUILD CALL and `foldGraph` "IGNORES a repeated node id rather than
 * overwriting". So without this, segment 2's `graph_agent` for `n2`
 * (`nextjs-developer`) is DROPPED and every later `graph_tool{node:"n2"}` from
 * the build attaches to segment 1's `n2` (`taste-frontend-expert`). The canvas
 * renders cleanly and attributes the build's work to the designer.
 *
 * The resumed session's ROOT is the exception: it is the same session, so it maps
 * onto the existing root rather than minting a second one.
 */
export function makeSegmentRemap(base: GraphResumeState): (event: GraphSseEvent) => GraphSseEvent {
  const mapping = new Map<string, string>();
  let next = base.minted;

  const resolve = (node: string, isRoot: boolean): string => {
    const known = mapping.get(node);
    if (known !== undefined) return known;
    if (isRoot && base.rootNode !== null) {
      mapping.set(node, base.rootNode);
      return base.rootNode;
    }
    next += 1;
    const minted = `n${String(next)}`;
    mapping.set(node, minted);
    return minted;
  };

  return (event: GraphSseEvent): GraphSseEvent => {
    if (event.type === "graph_inventory") return event;
    if (event.type === "graph_agent") {
      const node = resolve(event.node, event.parent === null);
      const parent = event.parent === null ? null : resolve(event.parent, false);
      return { ...event, node, parent };
    }
    return { ...event, node: resolve(event.node, false) };
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 11 tests in `build-segment.test.js`.

- [ ] **Step 5: Negative control — prove the collision is real, then prove the fix closes it**

This one needs both halves, because "the ids differ" proves nothing on its own.

1. **Show the collision.** Replace `makeSegmentRemap`'s body with `return (event) => event;` and re-run.
   Expected: FAIL with `SEGMENT 2's NODES DO NOT COLLIDE WITH SEGMENT 1's`.
2. **Show the fold consequence**, which is the failure that actually matters. Add this test and run it against the identity remap from (1):

```ts
test("FOLD-LEVEL PROOF: without the remap, the build's tools land on the designer's node", async () => {
  const { foldGraphAll } = await import("./graph.js");
  const remap = makeSegmentRemap(graphResumeState(SEGMENT_ONE));
  const state = foldGraphAll([
    ...SEGMENT_ONE,
    ...[agentEvent("n1", null, "orchestrator"), agentEvent("n2", "n1", "nextjs-developer"), toolEvent("n2", "Write")].map(remap),
  ]);
  const designer = state.nodes.find((n) => n.agent === "taste-frontend-expert");
  assert.ok(designer !== undefined);
  assert.equal(
    designer.tools.some((t) => t.name === "Write"), false,
    "the build agent's Write pill is attached to the DESIGNER's node",
  );
  assert.ok(state.nodes.some((n) => n.agent === "nextjs-developer"), "the build agent has a node of its own");
});
```
   Expected under the identity remap: FAIL with `the build agent's Write pill is attached to the DESIGNER's node`. Restore the real implementation; both go green.
3. Change the root branch to always mint. Re-run.
   Expected: FAIL with `segment 2's ROOT maps back onto segment 1's root`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/build-segment.ts dashboard/server/src/build-segment.test.ts <<'MSG'
feat(design): two build segments against one session, and the node-id fix

The build phase splits so the run can park between DESIGN and BUILD, which is
what §17's lock needs. Segment 2 passes segment 1's session_id, so this is NOT
the lane-per-query model §6.1 rejected: one session, one session id, every
parent_tool_use_id real. Segment 1's allowedAgents carry only the SPEC and
DESIGN lanes, so the delegation hook — not model cooperation — is what stops
BUILD starting early.

nextBuildSegment exists because `builderSessionId !== null` is true in four
situations needing three prompts; reading it alone would resume a post-lock
build with a prompt that names no locked mockup.

GraphProjection mints from n1 per BUILD CALL and foldGraph ignores a repeated
node id, so segment 2's n2 would be dropped and the build's tool pills would
attach to the designer's node — rendering cleanly and attributing the wrong
work. The remap extends the graph instead, mapping only the resumed root back
onto the existing one.
MSG
```

---

### Task 10: Wire the two segments into the run, and park between them

**Files:**
- Modify: `dashboard/server/src/orchestrator.ts` (`#buildPhase`, `resume`, `reconcileOnBoot`, `#recordScreenshots`'s neighbours)
- Modify: `dashboard/server/src/orchestrator.test.ts`
- Modify: `dashboard/server/src/db.ts` (three columns through the existing `RUN_MIGRATIONS` array) and `db.test.ts`
- Modify: `dashboard/server/src/tokens.ts` (`mergeTokenTotals`) and `tokens.test.ts`
- Create: `dashboard/server/src/design-segment-probe.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: `resume(runId: string, chosenMockup?: string | null): boolean` on `Orchestrator` (and therefore on `RunController`); `results/design-lock.json`; mockups registered through the existing `store.addScreenshot` + `screenshot` event.

**The shape of `#buildPhase` after this task:**

```
laneMode      = designLaneMode({ surface, ticketText, capability, preflightOk })
segment       = nextBuildSegment({ laneMode, manifestExists, manifestLocked, sessionId, designSegmentDone })

segment "design" | "design-resume":
    allowedAgents = shortlistFor(surface, laneMode) ∩ (SPEC ∪ DESIGN lanes)
    prompt        = designSegmentPrompt({ …, autoChoose: policy === "auto" })
    build()  →  read the manifest, count the PNGs, classifyDesignLane, write design-lane.json
             →  register each mockup as a screenshot
             →  policy "auto"  : lock from choice.json, else fallbackChoice, then fall through
                policy "ask"   : PARK — status awaiting_input, arm the timeout, return
segment "build" | "build-resume":
    allowedAgents = shortlistFor(surface, laneMode)          (the full set)
    prompt        = resume prompt + designHandoffSection(manifest, laneMode, workspace, dials)
    build()
```

- [ ] **Step 1: Write the failing test**

```ts
// appended to dashboard/server/src/orchestrator.test.ts
test("an ASK run parks at awaiting_input with its mockups visible", async () => {
  const harness = await runToDesignPark({ ticket: "a portfolio page", designLock: "ask" });
  const detail = harness.detail();
  assert.equal(detail.status, "awaiting_input");
  assert.equal(detail.designLock?.awaiting, true);
  assert.equal(detail.designLock?.mockups.length, 5, "the owner cannot click what the API does not list");
  assert.equal(detail.designLock?.locked, null);
});

test("an AUTO run never parks, and records who chose and why", async () => {
  const harness = await runFullTicket({ ticket: "a portfolio page", designLock: "auto" });
  const detail = harness.detail();
  assert.notEqual(detail.status, "awaiting_input");
  assert.ok(detail.designLock?.locked !== null);
  assert.ok(["ui-designer", "fallback"].includes(String(detail.designLock?.lockedBy)));
  assert.ok(String(detail.designLock?.reason).length > 0);
});

test("resuming with a chosen mockup locks THAT mockup and starts the build segment", async () => {
  const harness = await runToDesignPark({ ticket: "a portfolio page", designLock: "ask" });
  const chosen = harness.detail().designLock?.mockups[1]?.path ?? "";
  assert.equal(harness.orchestrator.resume(harness.runId, chosen), true);
  await harness.settle();
  assert.equal(harness.detail().designLock?.locked, chosen);
  assert.equal(harness.detail().designLock?.lockedBy, "owner");
  assert.equal(harness.builderCalls.length, 2, "two build() calls, not one and not three");
});

test("resuming with a path that is not a mockup is REFUSED and the run stays parked", async () => {
  const harness = await runToDesignPark({ ticket: "a portfolio page", designLock: "ask" });
  assert.equal(harness.orchestrator.resume(harness.runId, "/etc/passwd"), false);
  assert.equal(harness.detail().status, "awaiting_input");
});

test("ONE SESSION ACROSS BOTH SEGMENTS — this is what keeps §6.1's edges real", async () => {
  const harness = await runFullTicket({ ticket: "a portfolio page", designLock: "auto" });
  const [first, second] = harness.builderCalls;
  assert.equal(first?.resumeSessionId, null);
  assert.equal(second?.resumeSessionId, first?.observedSessionId);
});

test("segment 1 CANNOT reach a build agent — the boundary is the guard, not the prompt", async () => {
  const harness = await runToDesignPark({ ticket: "a portfolio page", designLock: "ask" });
  const allowed = harness.builderCalls[0]?.allowedAgents ?? [];
  assert.ok(allowed.includes("taste-frontend-expert"));
  assert.ok(allowed.includes("context-manager"), "the SPEC lane runs first; it owns the context DESIGN reads");
  assert.equal(allowed.includes("nextjs-developer"), false);
  assert.equal(allowed.includes("code-reviewer"), false);
});

test("segment 2's prompt carries the locked mockup's ABSOLUTE path", async () => {
  const harness = await runFullTicket({ ticket: "a portfolio page", designLock: "auto" });
  const locked = String(harness.detail().designLock?.locked);
  assert.ok(harness.builderCalls[1]?.prompt.includes(locked), "§7.3 mechanism 2, at the seam it crosses");
});

test("TOKENS ACCUMULATE ACROSS SEGMENTS — segment 2 must not clobber segment 1", async () => {
  // orchestrator.ts:721-723 writes toApiTokens(outcome.tokens) onto the row PER
  // CALL, so today's code would report segment 2's number as the run's.
  //
  // THE HARNESS MAKES SEGMENT 2 SMALLER ON PURPOSE (1000 in, then 10), which is
  // what makes this test red-able WITHOUT knowing whether a resumed session
  // reports per-call or cumulative totals. Under a clobber the row reads 10 and
  // this fails; under either summing or max-ing it passes. Which of those two is
  // correct is a question about the SDK — see Step 6's probe.
  const harness = await runFullTicket({
    ticket: "a portfolio page",
    designLock: "auto",
    segmentTokens: [{ inputTokens: 1000 }, { inputTokens: 10 }],
  });
  assert.ok(
    (harness.detail().tokens?.inputTokens ?? 0) >= 1000,
    "the run reports at least what the design segment spent",
  );
});

test("RULE 1: a parked run auto-selects when the timeout expires", async () => {
  // The timer is an external mechanism; this asserts it FIRES, not that it exists.
  const harness = await runToDesignPark({
    ticket: "a portfolio page",
    designLock: "ask",
    env: { DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN: "0.01" }, // 600 ms
  });
  await harness.waitForStatus("running", 5_000);
  await harness.settle();
  assert.notEqual(harness.detail().designLock?.locked, null);
  assert.equal(harness.detail().designLock?.lockedBy, "fallback", "no chooser ran, and it says so");
});

test("RULE 1: a restart during a park does not make the park infinite", async () => {
  const harness = await runToDesignPark({ ticket: "a portfolio page", designLock: "ask" });
  harness.rewindParkTime(60 * 60 * 1000);  // parked an hour ago
  harness.orchestrator.reconcileOnBoot();
  await harness.settle();
  assert.notEqual(harness.detail().status, "awaiting_input");
});

test("segment 2's canvas nodes extend segment 1's instead of colliding with them", async () => {
  // Task 9's remap, at the seam it protects. GraphProjection mints from n1 per
  // build call and foldGraph ignores a repeat, so an unremapped segment 2 puts
  // the build agent's pills on the designer's node — rendering cleanly.
  const harness = await runFullTicket({ ticket: "a portfolio page", designLock: "auto" });
  const agents = harness.emittedGraph().filter((e) => e.type === "graph_agent");
  const ids = agents.map((e) => e.node);
  assert.equal(new Set(ids).size, ids.length - 1, "exactly one repeat: the resumed session's root");
  const roots = agents.filter((e) => e.parent === null).map((e) => e.node);
  assert.equal(new Set(roots).size, 1, "one session, one root node");
});

test("a DEGRADED lane still runs both segments and hands over the written direction", async () => {
  const harness = await runFullTicket({ ticket: "a portfolio page", designLock: "auto", noKey: true });
  assert.equal(harness.builderCalls.length, 2);
  assert.match(String(harness.builderCalls[1]?.prompt), /direction\.md/);
  assert.equal(harness.detail().designLock?.locked, null, "nothing to lock, and nothing invented");
});
```

The harness (`runToDesignPark`, `runFullTicket`) drives a **fake `SubscriptionBuilder`** that records each `BuildRequest`, emits a `session` id on the first call, writes five 1×1 PNGs plus a manifest into the workspace on the design segment, and returns a clean `BuildOutcome`. It never spawns a CLI: this task tests the orchestrator's sequencing, not the SDK's.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/orchestrator.test.js"`
Expected: FAIL — `detail.designLock` is `undefined` and `builderCalls.length` is 1.

- [ ] **Step 3: Implement**

In `#buildPhase`, before the existing `resuming` logic, compute the lane and the segment:

```ts
    const surface = classifySurface(ticket.brief);
    const capability = detectDesignCapability({
      env: this.#deps.env,
      homeDir: this.#deps.env["HOME"] ?? homedir(),
      imageScript: designScriptPath(this.#deps.env, this.#deps.env["HOME"] ?? homedir()),
    });
    // THE PURE GATE FIRST. `designSurfaceGate` is the only term that can answer
    // "off", so a cli/api/library ticket never pays the preflight's `npx` probe.
    const gated = designSurfaceGate(surface, ticket.brief);
    const preflight = gated
      ? await designPreflight({
          env: this.#deps.env,
          homeDir: this.#deps.env["HOME"] ?? homedir(),
          workspace: runPaths.workspace,
          capability,
          run: execCommandRunner,
          canWrite: canWriteDir,
        })
      : { checks: [], ok: true, blockers: [] };
    const laneMode = designLaneMode({ surface, ticketText: ticket.brief, capability, preflightOk: preflight.ok });
    for (const check of preflight.checks) {
      if (!check.ok) this.#emitLog(runId, check.blocking ? "warn" : "info", `design preflight — ${check.detail}`);
    }

    const manifest = readDesignManifest(runPaths.workspace);
    const segment = nextBuildSegment({
      laneMode,
      manifestExists: manifest !== null,
      manifestLocked: manifest?.lockedMockup != null,
      sessionId: row.builderSessionId,
      designSegmentDone: row.designSegmentDone,
    });
```

**Three new columns on `runs`**, added through the existing `RUN_MIGRATIONS` array in `db.ts` — the pattern is already there with its own test, and it exists because `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a reader selecting a new column would throw on the owner's database while every test stayed green:

```ts
  {
    column: "design_segment_done",
    ddl: "ALTER TABLE runs ADD COLUMN design_segment_done INTEGER NOT NULL DEFAULT 0",
  },
  {
    column: "design_lock",
    ddl: "ALTER TABLE runs ADD COLUMN design_lock TEXT NOT NULL DEFAULT ''",
  },
  {
    column: "interactive",
    ddl: "ALTER TABLE runs ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0",
  },
```

All three defaults are the "nothing recorded yet" value and all three are TRUE of every historical row: no run before this phase had a design segment, stated a lock policy, or was marked interactive. `RunRow` gains `designSegmentDone: boolean`, `designLock: string`, `interactive: boolean`, and `RunPatch` gains the first. **They are added here rather than in Task 11 because this is the task that first reads them** — a column whose only writer ships two tasks later is a column nobody can test.

The two segments then differ in exactly three inputs:

```ts
    const designLanes = new Set<string>([...DELIVERY_LANES.spec, ...DELIVERY_LANES.design]);
    const fullShortlist = shortlistFor(surface, laneMode);
    const designSegment = segment === "design" || segment === "design-resume";
    const allowedAgents = designSegment
      ? fullShortlist.filter((agent) => designLanes.has(agent))
      : fullShortlist;

    const policy = designLockPolicy(row.designLock, row.interactive);
    const prompt = designSegment
      ? designSegmentPrompt({
          ticketText: ticket.brief,
          workspace: runPaths.workspace,
          mode: laneMode,
          capability,
          autoChoose: policy === "auto",
        })
      : this.#buildSegmentPrompt(row, ticket, runPaths, manifest, laneMode, allowedAgents);
```

After the design segment's `build()` returns, classify, record, register the mockups, and either lock or park:

```ts
    if (designSegment && !outcome.cancelled && !outcome.rateLimit.limited) {
      store.updateRun(runId, { designSegmentDone: true });
      const after = readDesignManifest(runPaths.workspace);
      const record = classifyDesignLane({
        mode: laneMode,
        manifest: after,
        pngCount: countDesignPngs(refsDirFor(runPaths.workspace)),
        imageCalls: imageCallCount,     // counted from the `tool` sink, below
        keySource: capability.key.source,
        preflight: preflight.checks,
      });
      writeDesignLaneRecord(runPaths.results, record);
      // THE TRAP. A failure here is a named, error-level line — never an absence.
      const failure = designLaneFailureMessage(record);
      if (failure !== null) {
        this.#emitLog(runId, "error", failure);
        store.updateRun(runId, { failureReason: failure });
      }
      this.#recordDesignMockups(runId, runPaths, after);

      if (after !== null && after.lockedMockup === null) {
        if (policy === "ask") {
          this.#parkForDesignLock(runId, runPaths);
          return null;                                  // segment 2 starts on resume
        }
        const at = new Date().toISOString();
        const attempt =
          readChoiceFile(refsDirFor(runPaths.workspace), after, at) ??
          fallbackChoice(after, at, "ui-designer wrote no choice.json");
        this.#applyDesignLock(runId, runPaths, after, attempt);
      }
    }
```

`imageCallCount` comes from the sink that is already there — `tool: (name, summary) => …` — incremented whenever a `Bash` summary names the image script. It counts **attempts including retries**, which is what makes a zero-image failure say *"after 3 generation attempts"* rather than *"after 0"*, and those two sentences point at completely different faults.

`buildSegmentPrompt` is the existing prompt plus §7.3's handoff block, and it is the only place the two are joined — so a resumed build cannot lose the design by taking a different branch:

```ts
  #buildSegmentPrompt(
    row: RunRow,
    ticket: Ticket,
    runPaths: RunPaths,
    manifest: DesignManifest | null,
    laneMode: DesignLaneMode,
    shortlist: readonly string[],
  ): string {
    const base =
      row.builderSessionId === null
        ? dashboardBuilderPrompt({
            ticketText: ticket.brief,
            workspaceDir: runPaths.workspace,
            allowedAgents: shortlist,
          })
        : resumeBuilderPrompt(
            manifest?.lockedMockup != null
              ? "the design was locked and the build continues from there"
              : row.rateLimited
                ? "the provider's rate-limit window was exhausted"
                : "the dashboard was interrupted",
          );
    const handoff = designHandoffSection({
      // PRUNED, not raw. `classifyDesignLane` has already recorded the
      // discrepancy for the report; the PROMPT must carry only paths that
      // resolve, or a partial lane becomes a Read failure inside every build
      // agent, several turns deep, reported as the agent's confusion.
      manifest: manifest === null ? null : pruneMissingRefs(manifest),
      mode: laneMode,
      workspace: runPaths.workspace,
      dials: readDesignDirection(runPaths.workspace),
    });
    // The handoff goes LAST, closest to the work. An empty one appends nothing,
    // so a non-design run's prompt is byte-identical to what it is today.
    return handoff.length === 0 ? base : `${base}\n\n${handoff}`;
  }
```

**Note the third resume reason.** `resumeBuilderPrompt("the dashboard was interrupted")` is what a post-lock resume would otherwise say — a sentence that is false and that names no mockup. That is the exact failure `nextBuildSegment` exists to prevent, and this is the line where it would come back.

`#applyDesignLock` is the only writer of a lock, and it returns whether it took:

```ts
  /**
   * Validate the attempt, write it into BOTH places, and say whether it took.
   *
   * TWO PLACES ON PURPOSE: `manifest.json` inside the workspace, because that is
   * what the build agents and the visual gate read; and `design-lock.json` beside
   * the run record, because §17.3 rule 5 makes a locked design a recorded INPUT
   * to the gate and the workspace is the artefact, not the record.
   *
   * FALSE MEANS THE RUN STAYS PARKED. A refused choice that resumed anyway would
   * build to no design at all while the API had just answered 200.
   */
  #applyDesignLock(
    runId: string,
    runPaths: RunPaths,
    manifest: DesignManifest,
    attempt: LockAttempt | null,
  ): boolean {
    if (attempt === null) {
      this.#emitLog(runId, "warn", "there is nothing to lock: the DESIGN lane produced no mockups");
      return false;
    }
    const result = lockManifest(manifest, attempt);
    if (!result.ok) {
      this.#emitLog(runId, "warn", `the design lock was refused: ${result.error}`);
      return false;
    }
    writeDesignManifest(runPaths.workspace, result.manifest);
    writeDesignLock(runPaths.results, {
      awaiting: false,
      parkedAt: attempt.at,
      locked: attempt.path,
      lockedBy: attempt.by,
      reason: attempt.reason,
    });
    this.#emitLog(
      runId,
      "info",
      `design locked by ${attempt.by}: ${attempt.path} — ${attempt.reason}`,
    );
    return true;
  }
```

`#parkForDesignLock` is the whole park:

```ts
  #parkForDesignLock(runId: string, runPaths: RunPaths): void {
    const at = new Date().toISOString();
    writeDesignLock(runPaths.results, { awaiting: true, parkedAt: at, locked: null, lockedBy: null, reason: null });
    this.#deps.store.updateRun(runId, { status: "awaiting_input", queuePosition: null });
    this.#emit(runId, { type: "status", status: "awaiting_input" });
    this.#emitLog(
      runId,
      "info",
      `the DESIGN lane produced its mockups and the run is waiting for one to be chosen. ` +
        `POST /api/runs/${runId}/resume {"chosenMockup":"<path>"} locks it; with no choice inside ` +
        `${String(designLockTimeoutMin(this.#deps.env))} minutes, ui-designer picks and the choice is ` +
        `recorded as automatic.`,
    );
    // §17.3 rule 1: never blocks indefinitely. `unref` so a park never holds the
    // process open on shutdown.
    const timer = setTimeout(() => {
      this.#emitLog(runId, "warn", "no design choice arrived before the timeout; selecting automatically");
      this.resume(runId, null);
    }, designLockTimeoutMin(this.#deps.env) * 60_000);
    timer.unref();
    this.#designLockTimers.set(runId, timer);
  }
```

`resume` takes the choice, and **the design-lock branch comes first** — the existing body requeues and re-executes, which is exactly what segment 2 needs:

```ts
  resume(runId: string, chosenMockup: string | null = null): boolean {
    const row = this.#deps.store.getRun(runId);
    if (row === null || isTerminal(row.status)) return false;
    const runPaths = runPathsFor(this.#deps.paths, runId);
    const manifest = readDesignManifest(runPaths.workspace);
    if (row.status === "awaiting_input" && manifest !== null && manifest.lockedMockup === null) {
      const at = new Date().toISOString();
      const attempt =
        chosenMockup === null
          ? readChoiceFile(refsDirFor(runPaths.workspace), manifest, at) ??
            fallbackChoice(manifest, at, "no owner choice arrived before the timeout")
          : { path: chosenMockup, by: "owner" as const, reason: "chosen by the owner in the dashboard", at };
      // A REFUSED CHOICE LEAVES THE RUN PARKED. Resuming anyway would build to no
      // design at all while the API had just answered 200.
      if (!this.#applyDesignLock(runId, runPaths, manifest, attempt)) return false;
    }
    clearTimeout(this.#designLockTimers.get(runId));
    this.#designLockTimers.delete(runId);
    // …existing body unchanged from here…
  }
```

and `reconcileOnBoot` finishes an expired park rather than leaving it forever:

```ts
    for (const row of this.#deps.store.listByStatus("awaiting_input")) {
      const lock = readDesignLock(runPathsFor(this.#deps.paths, row.runId).results);
      if (lock === null || !lock.awaiting) continue;
      if (designLockExpired(lock.parkedAt, new Date().toISOString(), designLockTimeoutMin(this.#deps.env))) {
        this.#emitLog(row.runId, "warn", "the design-lock window expired while the dashboard was down");
        this.resume(row.runId, null);
      } else {
        this.#parkForDesignLock(row.runId, runPathsFor(this.#deps.paths, row.runId));  // re-arm the timer
      }
    }
```

**Without the re-arm, a restart during a park is an infinite park** — the timer lived in a process that no longer exists, and `awaiting_input` has no other exit.

**Task 9's remap is applied at the `graph` sink**, and its input comes from the durable rows rather than from memory — a park can span a dashboard restart, so in-memory state is not available on the second segment:

```ts
    // ONE PROJECTION PER BUILD CALL means segment 2 mints from `n1` again and
    // `foldGraph` IGNORES the repeat, so without this the build's tool pills
    // attach to the DESIGN agent's node. Folded from `eventsSince` for the same
    // reason `graphSnapshot` is: the park may have outlived the process.
    const priorGraph = store
      .eventsSince(runId, 0)
      .map((row) => row.event)
      .filter((event): event is GraphSseEvent => event.type.startsWith("graph_"));
    const remap = designSegment && row.builderSessionId === null
      ? (event: GraphSseEvent): GraphSseEvent => event
      : makeSegmentRemap(graphResumeState(priorGraph));
```

and the sink's one line changes from `graph: (event) => this.#emit(runId, event)` to `graph: (event) => this.#emit(runId, remap(event))`.

**Tokens, and the one thing about them this plan cannot settle from the repo.** `orchestrator.ts:721-723` writes `toApiTokens(outcome.tokens)` onto the row after each `build()`, so segment 2 would report *its* number as the run's. Whether a resumed session's `outcome.tokens` is per-call or already cumulative is **not knowable from the code** — nothing in the repo has run two segments. So the row takes the **larger** of what it holds and what just arrived, which is correct under both readings and never under-reports:

```ts
    // MAX, NOT SUM, AND THE REASON IS AN UNSETTLED QUESTION RATHER THAN A
    // PREFERENCE. If a resumed session reports CUMULATIVE totals, summing would
    // double-count segment 1; if it reports PER-CALL totals, max under-reports by
    // segment 1's share. Under-reporting a token count is a smaller lie than
    // inventing one, and this is the same rule `costUsd: null` follows. Step 6's
    // probe settles it; when it does, this becomes a sum and the comment goes.
    const merged = mergeTokenTotals(store.getRun(runId)?.tokens ?? null, toApiTokens(outcome.tokens));
    if (outcome.tokens.callCount > 0) store.updateRun(runId, { tokens: merged });
```

with `mergeTokenTotals(previous, incoming)` taking the field-wise maximum — a four-line pure function in `tokens.ts` with its own test (`a second segment never lowers the run's reported totals`).

Mockups become clickable through the route that already exists (§17.1: *"The screenshots route already serves images by basename"*). `serveScreenshot` resolves under `results/screenshots/<runId>/`, so each PNG is **copied** there — the workspace is the artefact and is not served:

```ts
  #recordDesignMockups(runId: string, runPaths: RunPaths, manifest: DesignManifest | null): void {
    if (manifest === null) return;
    const dir = join(this.#deps.paths.results, "screenshots", safeSegment(runId));
    mkdirSync(dir, { recursive: true });
    for (const ref of manifest.refs) {
      // Prefixed so a mockup can never collide with a gate screenshot's basename.
      const file = `design-${basename(ref.path)}`;
      copyFileSync(ref.path, join(dir, file));
      const label = `${DESIGN_MOCKUP_LABEL}${ref.section}`;
      this.#deps.store.addScreenshot(runId, { path: join(dir, file), label, capturedAt: new Date().toISOString() });
      this.#emit(runId, { type: "screenshot", path: join(dir, file), label });
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 11 new orchestrator tests plus every pre-existing one.

- [ ] **Step 5: Negative control**

1. Remove the `.filter((agent) => designLanes.has(agent))` narrowing. Re-run.
   Expected: FAIL with `segment 1 CANNOT reach a build agent`. Restore. *(This is the mutation that turns the deterministic boundary back into a request.)*
2. Change segment 2's `resumeSessionId` to `null`. Re-run.
   Expected: FAIL with `ONE SESSION ACROSS BOTH SEGMENTS`. Restore.
3. Delete the `if (!this.#applyDesignLock(...)) return false;` guard. Re-run.
   Expected: FAIL with `resuming with a path that is not a mockup is REFUSED`. Restore.
4. Delete the `reconcileOnBoot` re-arm branch. Re-run.
   Expected: FAIL with `RULE 1: a restart during a park does not make the park infinite`. Restore.
5. Make `remap` the identity function for both segments. Re-run.
   Expected: FAIL with `segment 2's canvas nodes extend segment 1's instead of colliding with them`. Restore. *(This is the mutation whose production symptom is a canvas that renders perfectly and attributes the build's work to the designer.)*

- [ ] **Step 6: Prove the SDK actually honours the resume — the live arm**

The two-segment design rests on one claim about an external tool: **`resume: <sessionId>` continues the same session rather than starting a new one.** Everything above tests our side of that. Write `dashboard/server/src/design-segment-probe.mjs` (pattern: the existing `antislop-probe.mjs`), run it once against the owner's subscription login, and record the result in the phase result:

| Arm | What is observed |
|---|---|
| **segment 1** | a trivial prompt ("remember the word FERROUS"); record `session_id` from `system/init` |
| **segment 2, armed** | a second `query` with `resume: <that id>`, prompting "what word did I ask you to remember?" — the reply names FERROUS, and `system/init.session_id` is **the same id** |
| **segment 2, control** | byte-identical second query with `resume` omitted — the model does **not** know the word |
| **tokens, both arms** | print `outcome.tokens` for segment 1 and segment 2. If segment 2's input total is **≥ segment 1's**, the SDK reports CUMULATIVE totals and `mergeTokenTotals`'s max is exactly right; if it is a small independent number, totals are PER-CALL and the merge should become a sum. **Record which**, and change the one line if it is the latter. |

The control is what makes the armed arm mean anything: without it, a model that guessed or a prompt that leaked the word would read as a successful resume. If the armed arm fails, **stop and report it** — the two-segment model is wrong and the park must move into a hook-await instead.

- [ ] **Step 7: Commit**

```bash
git commit -F - -- dashboard/server/src/orchestrator.ts dashboard/server/src/orchestrator.test.ts dashboard/server/src/db.ts dashboard/server/src/db.test.ts dashboard/server/src/tokens.ts dashboard/server/src/tokens.test.ts dashboard/server/src/design-segment-probe.mjs <<'MSG'
feat(design): run the DESIGN segment, park for the lock, then build to it

The build phase now runs two builder.build() calls against one session. Segment
1 carries only the SPEC and DESIGN lanes in allowedAgents, so the PreToolUse
delegation hook is what stops BUILD starting before a design is locked — not the
model choosing to stop.

An ASK run parks at awaiting_input with its mockups already registered as
screenshots, so the existing route serves them and the owner can click one. An
AUTO run never parks. The park is bounded by a timer AND by a park-time check on
boot, because a timer lives in a process that a restart destroys.

A refused choice leaves the run parked rather than resuming into a build with no
design, and a zero-image lane writes an error-level line naming the attempt
count.
MSG
```

---

### Task 11: The HTTP contract — `designLock` in, `chosenMockup` back, one field out

**The hazard specific to this task:** `contract-parity.test.ts` compares **event types only** — its three tests are `the client's RunEvent union names exactly the server's SseEvent members`, `the client registers an SSE listener for every server event type`, and `parseRunEvent has a case for every server event type`. **Nothing compares `RunDetail` across the two packages.** A field added to the server's `RunDetail` and forgotten in `dashboard/src/lib/api-types.ts` compiles clean on both sides and simply never renders. So the client edit is a **step in this task**, not a follow-up.

**Files:**
- Modify: `dashboard/server/src/api-types.ts` (`CreateRunRequest`, `RunDetail`, new `ApiDesignLock`)
- Modify: `dashboard/server/src/http.ts` (`createRun`, the resume route, `toDetail`)
- Modify: `dashboard/src/lib/api-types.ts` (the mirror, same commit)
- Modify: `dashboard/server/src/api.test.ts`
- Modify: `dashboard/server/src/contract-parity.test.ts` (the cross-package guard — it reads the client's source, because a client-side unit test would never run)

**Interfaces:**
- Consumes: `readDesignLock` (Task 10), `designLockPolicy` (Task 8).
- Produces:
```ts
export interface ApiDesignLock {
  /** The run is parked RIGHT NOW waiting for a mockup to be chosen. */
  readonly awaiting: boolean;
  /** The mockups, as screenshots the existing route already serves. */
  readonly mockups: readonly ApiScreenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
}
// RunDetail gains exactly one field:
readonly designLock: ApiDesignLock | null;   // null when the run has no DESIGN lane
// CreateRunRequest gains exactly one field:
readonly designLock: "auto" | "ask" | null;
```

**One nullable field, not four flat ones.** `null` means "this run has no DESIGN lane" and is distinguishable from `{awaiting:false, locked:null, …}`, which means "the lane ran and produced nothing to lock". Those are different facts and the UI shows different things for them.

- [ ] **Step 1: Write the failing test**

```ts
// appended to dashboard/server/src/api.test.ts
test("POST /api/runs accepts designLock and rejects an unknown value type", async () => {
  const created = await post("/api/runs", { ticketText: "a portfolio page", modelId: MODEL, designLock: "ask" });
  assert.equal(created.status, 201);
  const bad = await post("/api/runs", { ticketText: "x", modelId: MODEL, designLock: 7 });
  assert.equal(bad.status, 400);
  assert.match(String((bad.body as { message: string }).message), /designLock/);
});

test("a request with no designLock and no interactive marker defaults to auto (§17.3 rule 2)", async () => {
  const created = await post("/api/runs", { ticketText: "a portfolio page", modelId: MODEL });
  const detail = await get(`/api/runs/${runIdOf(created)}`);
  assert.equal((detail.body as RunDetail).designLock?.awaiting, false);
});

test("RunDetail.designLock is null for a run with no DESIGN lane", async () => {
  const created = await post("/api/runs", { ticketText: "a cli that renames files", modelId: MODEL });
  const detail = await get(`/api/runs/${runIdOf(created)}`);
  assert.equal((detail.body as RunDetail).designLock, null);
});

test("POST /api/runs/:id/resume accepts {chosenMockup} and still accepts an EMPTY body", async () => {
  // Every existing client posts nothing. Requiring a body would break resume for
  // rate-limited runs, which is the path this route was built for.
  const parked = await parkedRun();
  const empty = await post(`/api/runs/${parked.runId}/resume`, undefined);
  assert.equal(empty.status, 200);
});

test("a chosenMockup that is not one of the run's mockups is 409, not 200", async () => {
  const parked = await parkedRun();
  const bad = await post(`/api/runs/${parked.runId}/resume`, { chosenMockup: "/etc/passwd" });
  assert.equal(bad.status, 409);
  const detail = await get(`/api/runs/${parked.runId}`);
  assert.equal((detail.body as RunDetail).status, "awaiting_input", "a refused choice leaves it parked");
});

test("the mockups the API lists are fetchable from the screenshots route", async () => {
  // §17.1: "The screenshots route already serves images by basename." If the file
  // is not under results/screenshots/<runId>/, the owner sees five broken cards.
  const parked = await parkedRun();
  const detail = (await get(`/api/runs/${parked.runId}`)).body as RunDetail;
  const first = detail.designLock?.mockups[0];
  assert.ok(first !== undefined);
  const image = await getRaw(`/api/runs/${parked.runId}/screenshots/${basename(first.path)}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/png");
});

test("costUsd is STILL null on a run that spent real money on images", async () => {
  // The DESIGN lane spends through a key read from ~/.gemini/api_key. That spend
  // is a call count in design-lane.json and it never becomes a dollar figure here.
  const parked = await parkedRun();
  const detail = (await get(`/api/runs/${parked.runId}`)).body as RunDetail;
  assert.equal(detail.costUsd, null);
});
```

And the cross-package guard — **in the server package, reading the client's source**, which is this repo's established pattern for exactly this problem (`contract-parity.test.ts`'s header: *"The one thing that genuinely fails is a check that reads what the client actually declares"*). The client package's own `npm test` is Playwright, so a `*.test.ts` dropped into `dashboard/src/lib/` would never run:

```ts
// appended to dashboard/server/src/contract-parity.test.ts
test("CONTRACT: the client's RunDetail declares designLock", () => {
  // contract-parity's existing three tests compare EVENT types only. Nothing
  // compares RunDetail across the two packages, so a field added on the server
  // and forgotten here compiles clean on BOTH sides and silently never renders.
  const client = readFileSync(CLIENT_TYPES, "utf8");
  assert.match(client, /designLock/, "the client's RunDetail mirror has no designLock field");
  assert.match(client, /DesignLockState/, "the client has no shape for the lock state");
  assert.match(client, /"owner" \| "ui-designer" \| "fallback"/, "the client's lockedBy union has drifted");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `error TS2339: Property 'designLock' does not exist on type 'RunDetail'.`

- [ ] **Step 3: Implement**

Server `api-types.ts`, beside `ApiScreenshot`:

```ts
/**
 * The design lock (spec §17), as the UI needs it.
 *
 * ONE NULLABLE FIELD ON `RunDetail` RATHER THAN FOUR FLAT ONES, and the null is
 * load-bearing: `null` means this run has no DESIGN lane, while
 * `{awaiting:false, locked:null}` means the lane ran and produced nothing to
 * lock — a degraded lane, or one that failed. Those are different facts and the
 * UI says different things about them, which a boolean pair could not express.
 *
 * `mockups` are `ApiScreenshot`s because that is what the run already stores and
 * what `GET /api/runs/:id/screenshots/:file` already serves (§17.1: "The
 * screenshots route already serves images by basename").
 */
export interface ApiDesignLock {
  readonly awaiting: boolean;
  readonly mockups: readonly ApiScreenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
}
```

`RunDetail` gains `readonly designLock: ApiDesignLock | null;`, and `CreateRunRequest` gains:

```ts
  /**
   * §17.3 rule 2. Absent means AUTO for a non-interactive caller: a scheduled run
   * that parks forever waiting for a click is the exact failure unattended
   * operation exists to avoid.
   */
  readonly designLock: "auto" | "ask" | null;
```

`http.ts` — validation in `createRun`, beside the `deploy` check:

```ts
  const designLock = body["designLock"];
  if (designLock !== undefined && designLock !== null && designLock !== "auto" && designLock !== "ask") {
    sendError(response, 400, "invalid_body", 'designLock must be "auto", "ask" or absent', null);
    return;
  }
```

persisted through `store.createRun` into the `design_lock` and `interactive` columns **Task 10 already added**. `interactive` is `true` when the caller sent an explicit `designLock` **or** a `Referer` from the dashboard origin, and `false` otherwise — see CONCERN 6 for why the failure direction is the one it is.

The resume route reads an optional body:

```ts
  // POST /api/runs/:id/resume
  if (segments.length === 4 && segments[3] === "resume" && method === "POST") {
    let chosenMockup: string | null = null;
    const text = await readBody(request);
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const chosen = parsed["chosenMockup"];
        if (chosen !== undefined && typeof chosen !== "string") {
          sendError(response, 400, "invalid_body", "chosenMockup must be a string when present", null);
          return;
        }
        chosenMockup = typeof chosen === "string" ? chosen : null;
      } catch (error) {
        sendError(response, 400, "invalid_body", describeError(error), "POST a JSON object, or no body at all.");
        return;
      }
    }
    const resumed: boolean = deps.orchestrator.resume(runId, chosenMockup);
    if (!resumed) {
      sendError(
        response,
        409,
        "not_resumable",
        `run ${runId} is ${row.status} and cannot be resumed` +
          (chosenMockup === null ? "" : `, or ${chosenMockup} is not one of its mockups`),
        "A finished run is not resumed: re-running a scored artefact would overwrite a real result " +
          "with a second one taken under different conditions. Submit a new run instead.",
      );
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }
```

**An empty body still resumes**, which keeps the rate-limit path — the reason this route exists — working byte-identically.

`toDetail` gains the field, reading the record Task 10 writes:

```ts
function toDetail(row: RunRow, store: RunStore, paths: DashboardPaths): RunDetail {
  const screenshots = store.listScreenshots(row.runId);
  const lock = readDesignLock(runPathsFor(paths, row.runId).results);
  return {
    // …unchanged…
    screenshots,
    designLock:
      lock === null
        ? null
        : {
            awaiting: lock.awaiting,
            mockups: screenshots.filter((shot) => shot.label.startsWith(DESIGN_MOCKUP_LABEL)),
            locked: lock.locked,
            lockedBy: lock.lockedBy,
            reason: lock.reason,
          },
  };
}
```

with `export const DESIGN_MOCKUP_LABEL = "design mockup — ";` exported from `design-lock.ts` and used by `#recordDesignMockups` in Task 10, so the prefix has **one** definition rather than being typed twice.

**THE CLIENT MUST SEND `designLock: "auto"` UNTIL THE MOCKUP CARDS EXIST, and this is not optional.** `interactive` is true for a dashboard-submitted run, so `designLockPolicy` would return `"ask"` — and NOT COVERED 1 says no card UI ships in this phase. Joined up, that means **every web-UI ticket the owner submits from the dashboard parks for 30 minutes and then fallback-locks the first mockup**: worse than either end of the design, and produced by two individually-correct decisions in different sections. So `dashboard/src/lib/api.ts`'s create-run call sends it explicitly:

```ts
    // AUTO UNTIL THE MOCKUP CARDS EXIST. The server would otherwise treat a
    // dashboard submission as interactive and park the run at awaiting_input —
    // with no UI in this phase that can choose a mockup, that is a 30-minute
    // stall followed by an automatic pick. Delete this line in the same commit
    // that ships the cards, and not before.
    designLock: "auto",
```

with a matching test in `dashboard/server/src/contract-parity.test.ts` — the client's source is already read there, so the check costs nothing:

```ts
test("CONTRACT: the client sends designLock explicitly while there is no card UI", () => {
  const client = readFileSync(join(CLIENT_LIB, "api.ts"), "utf8");
  assert.match(client, /designLock:\s*"auto"/, "a dashboard-submitted run would park with nothing able to resume it");
});
```

The client mirror in `dashboard/src/lib/api-types.ts` — the same two additions, verbatim, **in this commit**:

```ts
export interface DesignLockState {
  readonly awaiting: boolean;
  readonly mockups: readonly Screenshot[];
  readonly locked: string | null;
  readonly lockedBy: "owner" | "ui-designer" | "fallback" | null;
  readonly reason: string | null;
}
```
plus `readonly designLock: DesignLockState | null;` on `RunDetail` and `readonly designLock: "auto" | "ask" | null;` on the create-run body.

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
then `cd dashboard && npm run typecheck`
Expected: PASS on both.

- [ ] **Step 5: Negative control**

1. Remove `designLock` from the **client** `RunDetail` only. Re-run `npm run typecheck` in `dashboard/`, then the server suite.
   Expected: **the typecheck stays green on both sides**, and only `CONTRACT: the client's RunDetail declares designLock` goes red. That asymmetry is the point — nothing else in the repo catches this. Restore.
2. Change the resume route to require a body. Re-run.
   Expected: FAIL with `POST /api/runs/:id/resume … still accepts an EMPTY body`. Restore.
3. Make `toDetail` return `designLock: null` unconditionally. Re-run.
   Expected: FAIL with `the mockups the API lists are fetchable from the screenshots route`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/api-types.ts dashboard/server/src/http.ts dashboard/server/src/api.test.ts dashboard/server/src/contract-parity.test.ts dashboard/src/lib/api-types.ts <<'MSG'
feat(design): designLock on the request, the lock state on the detail

One nullable field on RunDetail, and the null is load-bearing: null means this
run has no DESIGN lane, while {awaiting:false, locked:null} means the lane ran
and produced nothing to lock. The client mirror moves in the same commit because
contract-parity.test.ts compares EVENT types only — a RunDetail field forgotten
on the client compiles clean on both sides and never renders.

resume() takes an optional {chosenMockup} and still accepts an empty body, so
the rate-limit path it was built for is untouched. A chosen path that is not one
of the run's mockups answers 409 and leaves the run parked.
MSG
```

---

### Task 12: The DESIGN → REVIEW link — the visual gate, and the author who may not grade

**§7.4, in full:** *"The visual gate is `ui-designer`, deliberately not the mockup author — an agent grading its own art direction is not a gate. It is one of only two shortlisted agents with Bash + Read + Write together, which is exactly what driving Playwright and writing a report requires."* Verified against disk: `ui-designer.md` declares `tools: Read, Write, Edit, Bash, Glob, Grep`, and `agent-shortlist.ts` already places it in **both** `design` and `review` — *"it holds design tokens in DESIGN and grades the built page against the mockups in REVIEW, while `taste-frontend-expert` authors those mockups."*

**Files:**
- Modify: `dashboard/server/src/design-prompt.ts` (add `visualGatePrompt`)
- Modify: `dashboard/server/src/design-prompt.test.ts`

**Interfaces:**
- Consumes: `DesignManifest` (Task 1), `visualCriteriaFor` + `toVisualManifest` (Task 1).
- Produces:
```ts
export const VISUAL_GATE_AGENT = "ui-designer";
export const VISUAL_GATE_AUTHOR = "taste-frontend-expert";
export const VISUAL_GATE_REPORT = "review/visual-gate.md";
export function visualGatePrompt(input: { manifest: DesignManifest | null; workspace: string; previewUrl: string | null }): string;
```

- [ ] **Step 1: Write the failing test**

```ts
// appended to dashboard/server/src/design-prompt.test.ts
import { visualGatePrompt, VISUAL_GATE_AGENT, VISUAL_GATE_AUTHOR, VISUAL_GATE_REPORT } from "./design-prompt.js";
import { visualCriteriaFor } from "./visual-criteria.js";
import { toVisualManifest } from "./design-manifest.js";

test("the gate is ui-designer and NEVER the author", () => {
  assert.equal(VISUAL_GATE_AGENT, "ui-designer");
  assert.notEqual(VISUAL_GATE_AGENT, VISUAL_GATE_AUTHOR);
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: "http://127.0.0.1:4180" });
  assert.doesNotMatch(p, /taste-frontend-expert/, "an agent grading its own art direction is not a gate");
});

test("the gate grades against the LOCKED mockup, one screenshot per section, at the mockup's aspect", () => {
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: "http://127.0.0.1:4180" });
  assert.ok(p.includes(HERO));
  assert.match(p, /21:9/, "the hero's aspect, so the screenshot is comparable to the still");
  assert.match(p, /http:\/\/127\.0\.0\.1:4180/);
  assert.ok(p.includes(VISUAL_GATE_REPORT));
});

test("the gate is told it is QUALITY and NON-BLOCKING", () => {
  // Owner decision, spec decision #9 and §7.4: subjective judgement informs, it
  // does not false-fail a run. A gate that thinks it can fail a build will write
  // a report that reads like one.
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: null });
  assert.match(p, /QUALITY/);
  assert.match(p, /never blocks|non-blocking/i);
});

test("every criterion the gate is handed is QUALITY tier — asserted through the real module", () => {
  for (const criterion of visualCriteriaFor(toVisualManifest(LOCKED))) assert.equal(criterion.tier, "QUALITY");
});

test("with no mockups the gate still runs, on the rule-based floor", () => {
  // Spec §6.5: "the visual gate falls back to rule-based scoring with no
  // reference PNGs". A degraded lane must not silently skip the gate.
  const p = visualGatePrompt({ manifest: null, workspace: WS, previewUrl: null });
  assert.ok(p.length > 0);
  assert.match(p, /no reference/i);
  assert.ok(visualCriteriaFor({ lockedMockup: null }).length > 0);
});

test("with no preview URL the gate says what it cannot do rather than pretending", () => {
  const p = visualGatePrompt({ manifest: LOCKED, workspace: WS, previewUrl: null });
  assert.match(p, /no preview/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b`
Expected: FAIL with `has no exported member 'visualGatePrompt'`.

- [ ] **Step 3: Implement** — append to `design-prompt.ts`

```ts
/**
 * The visual gate is `ui-designer`, and the author is named here only so the
 * separation is checkable rather than remembered (spec §7.4: "an agent grading
 * its own art direction is not a gate").
 */
export const VISUAL_GATE_AGENT = "ui-designer";
export const VISUAL_GATE_AUTHOR = "taste-frontend-expert";
export const VISUAL_GATE_REPORT = "review/visual-gate.md";

export function visualGatePrompt(input: {
  manifest: DesignManifest | null;
  workspace: string;
  previewUrl: string | null;
}): string {
  const lines: string[] = [
    "VISUAL GATE — QUALITY tier, and it NEVER blocks a run.",
    "",
    "You are grading, not building, and you did not author what you are grading.",
    "Report what you find; a finding informs the owner and does not fail the build.",
    "",
  ];
  lines.push(
    input.previewUrl === null
      ? "There is no preview URL for this run, so no screenshots can be captured. Grade what " +
        "you can from the source in the workspace and say plainly which criteria you could not " +
        "answer — an unanswerable criterion reported as a pass is worse than one reported as unknown."
      : `The built site is running at ${input.previewUrl}. Capture ONE screenshot per section with ` +
        `Playwright, at the aspect ratio of that section's mockup, so the pair is comparable.`,
    "",
  );

  if (input.manifest === null || input.manifest.refs.length === 0) {
    lines.push(
      "THERE IS NO REFERENCE IMAGE for this run — the DESIGN lane degraded. Grade against the",
      "rule-based floor alone and say so in the report; do not invent a reference.",
      "",
    );
  } else {
    lines.push("Read each mockup and its screenshot as a pair:", "");
    for (const ref of input.manifest.refs) {
      const locked = ref.path === input.manifest.lockedMockup;
      lines.push(`  ${locked ? "LOCKED  " : "        "}${ref.path}   [${ref.section}, ${ref.aspect}] ${ref.intent}`);
    }
    lines.push(
      "",
      input.manifest.lockedMockup === null
        ? "No mockup was locked, so grade against the set and say that the comparison is loose."
        : `Grade against the LOCKED mockup: ${input.manifest.lockedMockup}. The question is "does this ` +
          `match the design that was CHOSEN", not "does this resemble something we generated". ` +
          `Resembling a different mockup from the set is not a pass.`,
      "",
    );
  }

  lines.push(
    `Write ${VISUAL_GATE_REPORT}: one verdict per section, each naming the criterion, what you saw,`,
    "and what would close the gap. Every criterion is QUALITY tier — it reports, it never blocks.",
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd dashboard/server && npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"`
Expected: PASS, 6 further tests in `design-prompt.test.js`.

- [ ] **Step 5: Negative control**

1. Change `VISUAL_GATE_AGENT` to `"taste-frontend-expert"`. Re-run.
   Expected: FAIL with `the gate is ui-designer and NEVER the author`. Restore.
2. Delete the `QUALITY … never blocks` line. Re-run.
   Expected: FAIL with `the gate is told it is QUALITY and NON-BLOCKING`. Restore.
3. Make `visualGatePrompt` return `""` when `manifest === null`. Re-run.
   Expected: FAIL with `with no mockups the gate still runs, on the rule-based floor`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -F - -- dashboard/server/src/design-prompt.ts dashboard/server/src/design-prompt.test.ts <<'MSG'
feat(design): the visual gate prompt — ui-designer, never the author

An agent grading its own art direction is not a gate (§7.4), so the gate agent
and the mockup author are separate constants and a test asserts the author's
name never appears in the gate's prompt.

It grades against the LOCKED mockup — "does this match the design that was
chosen" rather than "does this resemble something we generated" — at the
mockup's own aspect ratio so the pair is comparable. QUALITY tier and
non-blocking, stated in the prompt itself: a gate that thinks it can fail a
build writes a report that reads like one.

A degraded run still gets a gate, on the rule-based floor, with the absence of a
reference stated rather than papered over.
MSG
```

---

## Definition of done

- [ ] `npx tsc -p tsconfig.json --outDir dist-2b && node --test "dist-2b/**/*.test.js"` passes, and every pre-existing test is still green — in particular `visual-criteria.test.js`, `agent-shortlist.test.js`, `contract-parity.test.js` and `api.test.js`.
- [ ] `cd dashboard && npm run typecheck` passes.
- [ ] **A `full` lane that produced zero images is loud in all four places** (Task 7 Step 5): `design-lane.json`, an error-level log event, the run's `failureReason`, and the build log carrying the script's own stderr. Both arms of that control were executed and their `design-lane.json` recorded verbatim.
- [ ] **The `mktemp -d` honours-`TMPDIR` proof was executed**, in both arms (Task 3).
- [ ] **The live resume probe was run** and its three arms recorded (Task 10 Step 6). If the armed arm failed, the phase is blocked, not shipped.
- [ ] All three §7.3 mechanisms are present and each has been individually removed and observed to turn a test red (Task 6 Step 5).
- [ ] **Segment 2's node ids extend segment 1's** rather than colliding, proven at both levels: the unit control (Task 9 Step 5.1) and the fold-level control that shows the build's tool pills landing on the designer's node without the remap (Task 9 Step 5.2).
- [ ] The visual gate's agent is `ui-designer` and the author's name appears nowhere in its prompt.
- [ ] `costUsd` is `null` on a run that generated images, and no field anywhere in the design record looks like money.
- [ ] **A two-segment run does not under-report tokens** — the merge is field-wise max, and the probe recorded whether a resumed session's totals are per-call or cumulative (if per-call, the merge became a sum in the same commit).
- [ ] **The client sends `designLock: "auto"`** and the parity test asserting it is green — without it, every dashboard-submitted web-UI ticket parks for the full timeout with no UI able to unpark it.
- [ ] `bakeoff/` untouched. `dashboard/STATUS.md` and `bakeoff/STATUS.md` untouched by this plan's tasks (the phase result is written into STATUS.md by whoever owns it, not by these commits).
- [ ] No AI-attribution trailer on any commit. No `--amend`. No `git push`.

## Spec coverage

| Spec | Where it lands |
|---|---|
| **§7.1** what "custom animation" means | Context only — no implementation. It is the mechanism 2c feeds; the handoff shape built in Tasks 1 and 6 is what it will ride on. See NOT COVERED. |
| **§7.1a** phase staging of the motion bar | Task 2 (`capability.video`, false while `gemini-video.sh` is absent), Task 3 (the `DASHBOARD_MOTION_BAR` flip claude-builder.ts deferred to this phase), Task 5 (the video ask is gated on the flag, so 2b never asks for an `.mp4`) |
| **§7.2** mockup generation | Task 5 — flags, model default, aspect set, `-i` chaining, sequential generation, closed loop with max 2 retries, ≥5 PNGs, `manifest.json`; Task 1 defines and validates the manifest |
| **§7.3** DESIGN → BUILD handoff | Task 6 — all three mechanisms, each with its own removal control; Task 10 injects the block into segment 2's prompt |
| **§7.4** DESIGN → REVIEW link | Task 12 — `ui-designer` not the author, `manifest.json` paths injected, one screenshot per section at the mockup's aspect, `review/visual-gate.md`, QUALITY and non-blocking |
| **§7.5** the risk table | Task 2 (`python3`, `npx impeccable`, the key, `TMPDIR` as preflight checks + the `sandbox.network` guard), Task 3 (`TMPDIR` set and proved, the key names' survival guarded), Task 7 (the invisible-failure row — THE TRAP), Task 7 again (the metered-call note) |
| **§17.1** the mechanism already exists | Task 10 — `awaiting_input`, `POST /api/runs/:id/resume`, mockups served by the existing screenshots route |
| **§17.2** why this makes the grader better | Task 8's header and Task 12 — the gate's question becomes "does this match the design that was CHOSEN" |
| **§17.3 rule 1** never blocks indefinitely | Task 8 (`designLockTimeoutMin`, `designLockExpired`), Task 10 (the timer, and the boot re-arm that stops a restart making a park infinite) |
| **§17.3 rule 2** cron auto-selects | Task 8 (`designLockPolicy`), Task 11 (`CreateRunRequest.designLock`) |
| **§17.3 rule 3** the auto-chooser is `ui-designer` | Task 5 (the prompt delegates the choice), Task 8 (`readChoiceFile` records `by: "ui-designer"`), Task 12 (the same separation rule) |
| **§17.3 rule 4** the choice is recorded either way | Task 8 (`lockManifest` refuses a blank reason; `fallbackChoice` records itself as a fallback), Task 10 (`design-lock.json`), Task 11 (`RunDetail.designLock`) |
| **§17.3 rule 5** a locked design is a recorded input to the gate | Task 10 (`results/design-lock.json` beside the run record, the same precedent as `writeEnvironmentRecord`), Task 12 (the gate reads it) |
| **§6.5** the DESIGN-lane predicate | Task 4 — verbatim, three-valued so degrade is a state |
| **§7.6.3** constraints 2c pushes back | Task 1 — `aspect` required now, `animate` optional and additive, with the no-version-bump rule stated |

## NOT COVERED — stated rather than left silent

1. **The clickable mockup cards themselves.** Task 11 delivers everything the UI needs (`RunDetail.designLock.mockups`, served by the existing screenshots route) and the client type mirror, but **no React component is planned here**. §17's diagram says "UI shows the 5 mockups as clickable cards"; that is a client task, and this plan's client surface stops at the type. **Because of that gap, the client sends `designLock: "auto"` explicitly** (Task 11 Step 3, with its own parity test) — otherwise a dashboard-submitted web-UI ticket would park for the full timeout with nothing in the UI able to unpark it. That line is deleted in the same commit that ships the cards, and not before.
2. **§7.1's scroll-scrubbed-video pipeline and all of §7.6 (Phase 2c).** Deliberate, per §12: "2c after 2b, not merged with it. 2b proves the still pipeline, the manifest and the handoff end to end." The only 2c work here is the manifest's forward-compatible shape.
3. **The canvas's "degraded lane" rendering.** §6.5 says "the canvas shows the lane as degraded". The *data* exists after this phase (`design-lane.json`, the error-level log event, `RunDetail.designLock`), but node styling belongs to Phase 3, which owns the canvas.
4. **Per-agent turn bounds for the DESIGN lane.** `boundsFor("taste-frontend-expert")` returns 30 and has no production caller — `agent-shortlist.ts` says so plainly, and both routes to applying it were measured closed. §11 item 3 stays open; this phase does not re-open it.
5. **The `graph_skill{source:"invoked"}` observation of the `image-to-code` bridge.** The instruction is delivered and tested (Task 6); *observing* the skill fire is an assertion about a live run, and no live end-to-end arm is planned for it. Stated so nobody reads Task 6 as proof the child invoked it.
6. **`npx impeccable` resolvability is recorded, not enforced.** §7.5's mitigation says "assert resolvable"; the check runs and reports, and does not block, for the reason given in Task 2.

## CONCERNS — where this plan believes the spec is wrong, written to the spec anyway

1. **§7.1a's satisfier table would make the Layer-2 gate STRICTER, not staged.** Its "Phases 2a/2b" row lists only "GSAP/ScrollTrigger timeline, or rAF-driven element scrubbing", while §8 Layer 2 lists scroll-scrubbed video **first** among the satisfiers and Phase 2a shipped it accepted. Removing an *accepted* satisfier cannot degrade-not-block: it would fail a build that legitimately scroll-scrubs a video — which is the technique the owner's own site uses. **This plan implements the rule the spec states in prose — "the gate must not demand video" — by gating what is ASKED FOR (Task 5) and never by narrowing what is ACCEPTED**, and Task 5's test asserts `decideMotion` cannot get stricter when the flag is false. If the table was meant literally, that is a one-line change in Phase 2a's `decideMotion` and it should be made deliberately, not inherited from a plan.
2. **§7.6.3 lists `aspect` as something 2c "gains", but §7.2 already puts it in the 2b manifest.** Written to §7.2: `aspect` is required from 2b, and 2c's addition is `animate` alone. If §7.6.3 is right, 2b files would carry no aspect and 2c could not tell a Veo-compatible still from a `21:9` one without re-reading every PNG.
3. **§6.3's "preloaded on frontend builders" is no longer achievable, and the repo already knows.** `Options.agents` was deleted after probe I measured that a definition registered under a name that also exists in `~/.claude/agents/` is not consulted at all; `api-types.ts:303-308` records that `AgentDefinition.skills` therefore "preloads nothing" and that `"preloaded"` has no producer. Writing `skills: ["image-to-code"]` would compile, read correctly and do nothing. **§7.3 mechanism 3 is implemented as an invocation instruction on the Agent call's `prompt`** — the only channel measured to reach a child.
4. **§17.1's "No new machinery" is true of the states and routes, and not of the plumbing.** `awaiting_input` and `POST /api/runs/:id/resume` are reused exactly as the spec says. But splitting the build into two `build()` calls, three new `runs` columns (`design_segment_done`, `design_lock`, `interactive`), an optional resume body and the node-id remap are all new. Recorded so a reviewer expecting a zero-cost feature is not surprised by the diff.
5. **`DesignLockedBy` has a third value the spec does not name.** §17.3 rule 3 names `ui-designer` as the auto-chooser and rule 4 requires the choice be recorded with who made it. When `ui-designer` writes no usable `choice.json`, recording the pick as `"ui-designer"` would be a lie about provenance and recording nothing would leave the gate with no reference on a run that had five mockups. Hence `"fallback"`, which says exactly what happened.
6. **"Not interactive" is undefined in §17.3 rule 2, so this plan defines it narrowly:** a request is interactive when it carries an explicit `designLock` **or** a `Referer` from the dashboard origin. Everything else — `curl`, cron, a script — is non-interactive and therefore `auto`. The failure direction was chosen deliberately: a mis-classified interactive request auto-selects (a mockup the owner did not pick, recorded as automatic), while a mis-classified cron request would park forever, which is the failure §17.3 rule 2 exists to prevent.
7. **§7.5's "Design-lane spend is tracked on its own line" cannot be a dollar figure.** `gemini-image.sh` prints only an output path, the `generateContent` response carries no price, and no price table exists in this program. The line is `imageCalls` + `imageModel`. A dollar figure invented here would be the same fabrication that `api-types.ts`'s header forbids for `costUsd`.

## Things this plan could not determine from the repo

1. **Whether the SDK's `resume: <sessionId>` genuinely continues the session across two `query()` calls.** The rate-limit path already relies on it and it is unmeasured. Task 10 Step 6 is the probe; the plan says plainly to stop if it fails.
2. **Whether a `21:9` still and a `21:9` Playwright screenshot are comparable enough for the gate to be useful.** §7.4's mechanism is specified; nothing in the repo has run it.
3. **Whether a resumed session's `outcome.tokens` is per-call or cumulative.** Nothing in the repo has ever run two segments, and the answer changes `mergeTokenTotals` from a max to a sum. The max is the safe branch — it can under-report, never invent — and Task 10 Step 6's probe settles it.
4. **The real false-positive rate of `visualIntent`.** Phase 2a measured its own rules against a corpus; this plan's keyword list has no corpus behind it, and the failure direction (a `fullstack` ticket paying for five images it did not want) costs real money. Worth a corpus pass over the calibration tickets once the lane runs.
