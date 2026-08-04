# Motion Capture — Plan A (host-side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ticket can carry a link to a site whose animation the owner likes; the run reads that page's motion into deterministic words the text-only spec seat can author from, and into a detail file the builder and design lane read.

**Architecture:** Four new modules in `dashboard/server/src`, three of them pure functions over data. A browser driver (`motion-capture.ts`) mirrors `site-capture.ts`'s injected-seam shape; a normalizer (`motion-spec.ts`) quantizes a raw reading into something stable enough to enter the ticket digest; a renderer (`motion-brief.ts`) turns that into brief prose. Wiring attaches at four existing points: the `POST /api/runs` body, ticket identity, brief composition, and the builder/design prompt sections.

**Tech Stack:** TypeScript (NodeNext, `exactOptionalPropertyTypes`), `node:test`, playwright (declared at `dashboard/server/package.json:29` under devDependencies, resolved by hoisting), Next.js 15 client with Playwright browser specs.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-04-motion-capture-design.md`. Every task's requirements implicitly include this section.

- **Zero files under `bakeoff/` may be modified.** Plan A touches `dashboard/` only. No protocol bump, no image rebuild, no recalibration. `calibration.test.ts` must be green at every commit.
- **Nothing volatile may enter the brief.** Allowed: family, element role, property set, duration bucketed to 50 ms, sibling stagger bucketed to 20 ms, easing family, direction, iteration count, scroll-linked ratio to two decimals. Forbidden: absolute start times, raw floats, frame counts, viewport-dependent counts, any path, any filename, any sentence naming an attachment.
- **`sha256` stays exactly `ticketDigest(brief)`.** Motion material enters `referenceIdentityMaterial` only. `assertTicketUnedited` (`bakeoff/src/spec-agent.ts:654`) throws otherwise.
- **Whatever is folded into identity at intake must be read back** by `ticketFromStoredReferences`, or the run authors a second suite on the owner's quota.
- **`captureSite` never throws; `captureMotion` must not either.** A slow third-party page must never refuse to create a run.
- **The sampler runs at `reducedMotion: "no-preference"`.** Measured: the container's existing capture path uses `"reduce"` and `animations: "disabled"`, which measures zero.
- **Every new timed page call moves `CAPTURE_BUDGET_MS`-style constants in lockstep.** `site-capture.test.ts` asserts an exact timeout count and an exact sum. An untimed playwright call silently inherits a 30 s default.
- **New client wire fields use the conditional-spread convention** at `dashboard/src/app/page.tsx:342-343`. Five browser specs assert the whole POST body with `toEqual`.
- **Commit messages follow the repo's convention:** lowercase `type(scope): sentence that states the change`, body long where the reasoning is non-obvious. **No AI attribution trailers, ever.**
- **Do not commit with `--amend`** — sibling agents may have committed in the gap.

---

## File Structure

**Created — `dashboard/server/src/`**

| file | responsibility |
|---|---|
| `motion-types.ts` | The shared types. No logic, no imports beyond `type`. Both waves code against it. |
| `motion-spec.ts` | PURE. `MotionReading` → `MotionSpec`. Quantization, sorting, family classification, the determinism rules. |
| `motion-brief.ts` | PURE. `MotionSpec` → the lines that go in the brief. Owns every word the spec seat reads. |
| `motion-capture.ts` | The browser driver. Injected `LaunchMotionBrowser` seam, the init-script sampler, budgets. Returns `MotionCaptureResult`. |
| `motion-spec.test.ts`, `motion-brief.test.ts`, `motion-capture.test.ts` | Seam-level tests. |
| `motion-capture.browser.test.ts` | REAL chromium against a local fixture. The test `site-capture.ts` never had. |
| `test-fixtures/motion-fixture.html` | The page the real-browser test drives. Known declared durations. |

**Modified — `dashboard/server/src/`**

| file | change |
|---|---|
| `http.ts` | `motionUrl` body field (beside `captureUrl`, :1785); `requestedMotionTarget`; `runMotionCapture` fail-soft wrapper; `HttpDeps.captureMotion` seam (:395); call before ticket identity is fixed (:1923-1926); motion line in `captureNotes` (:2034). |
| `ticket.ts` | `TicketReferences.motion?`; thread through `ticketWithReferences` (:217) and `ticketFromStoredReferences` (:269). |
| `ticket-refs.ts` | `ReferenceManifest.motion?` (:186); motion block in `composeBrief` (:327); `ticketProse` must strip it; `hasReferences` (:293); `builderReferenceSection` (:508) and `designReferenceSection` (:567). |
| `spec-assumptions.ts` | `AssumptionSource` gains `"reference"` (:104); `ownerSourced` (:107) includes it. |
| `api-types.ts` | `CreateRunRequest.motionUrl` (:1764); `RunDetail.motion`. |
| `contract-parity.test.ts` | `DETAIL_SHAPES` entry + field list (:687-708). |
| `graph-emit.ts` | `canSpawn` (:169) widened — the guessed-parent fix. |

**Modified — `dashboard/src/`**

| file | change |
|---|---|
| `lib/api-types.ts` | Hand-mirror `CreateRunRequest.motionUrl` (:852 area) and `RunDetail.motion` (:553-718). |
| `app/page.tsx` | Motion panel; tenth state hook (:175-183); conditional spread in `createRun` (:337-344); **rewrite the false "never a comparison against the live page" notice** (:560-567). |
| `components/canvas/sheet.tsx` | Motion readout panel beside `TicketAttachmentsPanel` (:729). |
| `tests/model-picker.browser.spec.ts` | `bodyFor` (:196) if the field ever goes unconditional — it must not. |

---

## Execution Waves

Drawn so **no two concurrent tasks touch the same file.**

```
WAVE 1 (5 parallel)   T1 motion-types+spec   T2 motion-brief   T3 guessed-parent
                      T4 provenance bucket   T5 client form + notice
WAVE 2 (2 parallel)   T6 motion-capture + real-browser test    T7 client mirror + parity
WAVE 3 (1)            T8 server wiring: identity, manifest, brief, intake
WAVE 4 (1)            T9 end-to-end verification against a real site
```

T2 codes against the `MotionSpec` type declared in T1 Step 1 — reproduced verbatim in T2 so neither agent waits.

---

## Task 1: Motion types and the normalizer

**Files:**
- Create: `dashboard/server/src/motion-types.ts`
- Create: `dashboard/server/src/motion-spec.ts`
- Test: `dashboard/server/src/motion-spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type below, plus `normaliseMotion(reading: MotionReading): MotionSpec` and `MOTION_BUCKET_MS = 50`, `STAGGER_BUCKET_MS = 20`.

- [ ] **Step 1: Create `motion-types.ts` with exactly this content**

```typescript
/**
 * motion-types.ts — the shapes, shared by the driver, the normalizer and the
 * renderer so none of them imports another's implementation.
 *
 * WHY A SEPARATE FILE. `motion-capture.ts` pulls playwright in at run time.
 * A test of the PURE normalizer must not, and would if the types lived there.
 */

/** The ten families held to parity, then the two that are presence-only. */
export type MotionFamily =
  | "load-entrance"
  | "scroll-reveal"
  | "scroll-linked"
  | "hover-focus"
  | "ambient-loop"
  | "split-text"
  | "path-draw"
  | "scroll-inertia"
  | "cursor-follow"
  | "tilt-3d"
  | "route-transition"
  | "canvas-ambient";

/** Families whose numbers may be compared. The other two are presence-only. */
export const PARITY_FAMILIES: readonly MotionFamily[] = Object.freeze([
  "load-entrance", "scroll-reveal", "scroll-linked", "hover-focus", "ambient-loop",
  "split-text", "path-draw", "scroll-inertia", "cursor-follow", "tilt-3d",
]);

/** One element's observed change, BEFORE quantization. Raw, never serialised. */
export interface RawObservation {
  readonly family: MotionFamily;
  /** `h1`, `div.card` — a role, never a selector that could be a path. */
  readonly role: string;
  /** Animated properties, e.g. ["opacity", "transform"]. */
  readonly props: readonly string[];
  readonly durationMs: number;
  /**
   * Milliseconds from sample start to first change.
   *
   * MEASURED TO DRIFT AND THEREFORE DROPPED BY `normaliseMotion`. Two cold runs
   * of gsap.com gave 200 ms and 600 ms for the same element while durations were
   * identical. It is carried here only so stagger can be derived from it.
   */
  readonly firstChangeMs: number;
  readonly easing: string | null;
  readonly iterations: number | null;
  /** Only for `scroll-linked`: px moved per px scrolled. */
  readonly scrollRatio: number | null;
}

export interface MotionReading {
  readonly url: string;
  readonly capturedAt: string;
  readonly observations: readonly RawObservation[];
  readonly libraries: readonly string[];
  readonly respectsReducedMotion: boolean;
}

/** One quantized, digest-safe entry. */
export interface MotionEntry {
  readonly family: MotionFamily;
  readonly role: string;
  readonly props: readonly string[];
  /** Bucketed to MOTION_BUCKET_MS. */
  readonly durationMs: number;
  /** Bucketed to STAGGER_BUCKET_MS. Null when the role has no siblings. */
  readonly staggerMs: number | null;
  readonly easing: string | null;
  readonly iterations: number | null;
  readonly scrollRatio: number | null;
  /** False for route-transition and canvas-ambient. */
  readonly parity: boolean;
}

export interface MotionSpec {
  readonly url: string;
  readonly capturedAt: string;
  readonly entries: readonly MotionEntry[];
  readonly libraries: readonly string[];
  readonly respectsReducedMotion: boolean;
}

export type MotionCaptureResult =
  | { readonly ok: true; readonly reading: MotionReading }
  | { readonly ok: false; readonly reason: string };
```

- [ ] **Step 2: Write the failing tests**

Create `dashboard/server/src/motion-spec.test.ts`:

```typescript
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { normaliseMotion } from "./motion-spec.js";
import type { MotionReading, RawObservation } from "./motion-types.js";

const obs = (over: Partial<RawObservation> = {}): RawObservation => ({
  family: "scroll-reveal", role: "div.card", props: ["opacity", "transform"],
  durationMs: 487, firstChangeMs: 200, easing: "ease-out", iterations: 1,
  scrollRatio: null, ...over,
});

const reading = (observations: readonly RawObservation[]): MotionReading => ({
  url: "https://example.com", capturedAt: "2026-08-04T00:00:00.000Z",
  observations, libraries: ["gsap"], respectsReducedMotion: false,
});

test("a duration is bucketed to 50ms, so 487 and 502 agree", () => {
  const a = normaliseMotion(reading([obs({ durationMs: 487 })]));
  const b = normaliseMotion(reading([obs({ durationMs: 502 })]));
  strictEqual(a.entries[0]?.durationMs, 500);
  deepStrictEqual(a.entries, b.entries);
});

test("THE MEASURED DEFECT: a drifting firstChangeMs cannot change the spec", () => {
  // Measured on gsap.com: the same element reported 200ms and 600ms across two
  // cold runs while its duration was identical both times. If this test fails,
  // every ticket re-mints its id on resubmission and re-authors the suite.
  const a = normaliseMotion(reading([obs({ firstChangeMs: 200 })]));
  const b = normaliseMotion(reading([obs({ firstChangeMs: 600 })]));
  strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test("stagger is DERIVED from sibling firstChange deltas, not from absolute time", () => {
  const spec = normaliseMotion(reading([
    obs({ role: "div.card", firstChangeMs: 100 }),
    obs({ role: "div.card", firstChangeMs: 218 }),
    obs({ role: "div.card", firstChangeMs: 340 }),
  ]));
  strictEqual(spec.entries[0]?.staggerMs, 120);
});

test("a lone role has no stagger rather than a stagger of zero", () => {
  const spec = normaliseMotion(reading([obs({ role: "h1" })]));
  strictEqual(spec.entries[0]?.staggerMs, null);
});

test("entries sort deterministically regardless of observation order", () => {
  const one = normaliseMotion(reading([obs({ role: "z.last" }), obs({ role: "a.first" })]));
  const two = normaliseMotion(reading([obs({ role: "a.first" }), obs({ role: "z.last" })]));
  deepStrictEqual(one.entries, two.entries);
});

test("presence-only families are marked parity:false", () => {
  const spec = normaliseMotion(reading([obs({ family: "canvas-ambient" }), obs({ family: "scroll-reveal" })]));
  const canvas = spec.entries.find((e) => e.family === "canvas-ambient");
  const reveal = spec.entries.find((e) => e.family === "scroll-reveal");
  strictEqual(canvas?.parity, false);
  strictEqual(reveal?.parity, true);
});

test("a 0ms change is a state flip, not motion, and is dropped", () => {
  const spec = normaliseMotion(reading([obs({ durationMs: 0 })]));
  strictEqual(spec.entries.length, 0);
});

test("easing collapses to a named family, so two cubic-beziers agree", () => {
  const a = normaliseMotion(reading([obs({ easing: "cubic-bezier(0.16, 1, 0.3, 1)" })]));
  const b = normaliseMotion(reading([obs({ easing: "cubic-bezier(0.17, 1, 0.29, 1)" })]));
  strictEqual(a.entries[0]?.easing, b.entries[0]?.easing);
});

test("a scroll ratio is rounded to two decimals", () => {
  const spec = normaliseMotion(reading([obs({ family: "scroll-linked", scrollRatio: 0.2537 })]));
  strictEqual(spec.entries[0]?.scrollRatio, 0.25);
});

test("NEGATIVE CONTROL: an empty reading produces an empty spec, not a fabricated one", () => {
  const spec = normaliseMotion(reading([]));
  strictEqual(spec.entries.length, 0);
  strictEqual(spec.libraries.length, 1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd dashboard/server && npm run build --silent && node --test dist/motion-spec.test.js
```
Expected: FAIL — `Cannot find module './motion-spec.js'`.

- [ ] **Step 4: Implement `motion-spec.ts`**

```typescript
/**
 * motion-spec.ts — a raw reading becomes something safe to hash.
 *
 * PURE, AND THAT IS THE POINT. Everything here runs on data, so the rules that
 * decide whether a ticket keeps its identity across two submissions are unit
 * testable without a browser.
 *
 * THE RULE THIS FILE EXISTS FOR. A composed brief is hashed into `ticket.sha256`
 * and into the ticket id, so any byte that wobbles between two captures of the
 * same page re-authors the acceptance suite and spends quota. Measured on
 * gsap.com across two cold runs: durations were IDENTICAL (150ms, 1000ms) and
 * absolute start times were NOT (200ms vs 600ms). So duration survives, start
 * time is dropped, and order is imposed rather than observed.
 *
 * THE BUCKETS ARE CHOSEN, NOT MEASURED, except the first. 50 ms for duration is
 * backed by the run-to-run comparison above. 20 ms for stagger and two decimals
 * for the scroll ratio are guesses; `motion-capture.browser.test.ts`'s
 * determinism case is what calibrates them, and each is a named constant so a
 * measured change is a one-line change.
 */
import type { MotionEntry, MotionReading, MotionSpec, RawObservation } from "./motion-types.js";
import { PARITY_FAMILIES } from "./motion-types.js";

export const MOTION_BUCKET_MS = 50;
export const STAGGER_BUCKET_MS = 20;

/** A change with no duration is a state flip — a dropdown snapping open. */
const MIN_DURATION_MS = 1;

const bucket = (value: number, size: number): number => Math.round(value / size) * size;

/**
 * Six named curves, because a raw `cubic-bezier(0.16, 1, 0.3, 1)` differs from
 * `cubic-bezier(0.17, 1, 0.29, 1)` by nothing a visitor could see and by enough
 * bytes to mint a new ticket.
 */
export function easingFamily(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (value === "linear") return "linear";
  const match = /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)/.exec(value);
  if (match === null) {
    if (value.startsWith("ease-in-out")) return "ease-in-out";
    if (value.startsWith("ease-in")) return "ease-in";
    if (value.startsWith("ease-out")) return "ease-out";
    if (value.startsWith("ease")) return "ease-out";
    return null;
  }
  const x1 = Number(match[1]);
  const x2 = Number(match[3]);
  if (x1 <= 0.2 && x2 >= 0.8) return "ease-out";
  if (x1 >= 0.4 && x2 <= 0.6) return "ease-in-out";
  if (x1 >= 0.4) return "ease-in";
  return "ease-out";
}

/**
 * The median gap between siblings' first changes.
 *
 * MEDIAN AND NOT MEAN: one late straggler (a card below the fold that reveals a
 * second later) would drag a mean into a number describing nothing.
 */
function staggerFor(group: readonly RawObservation[]): number | null {
  if (group.length < 2) return null;
  const starts = [...group].map((o) => o.firstChangeMs).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) gaps.push((starts[i] ?? 0) - (starts[i - 1] ?? 0));
  gaps.sort((a, b) => a - b);
  const middle = gaps[Math.floor(gaps.length / 2)] ?? 0;
  return bucket(middle, STAGGER_BUCKET_MS);
}

export function normaliseMotion(reading: MotionReading): MotionSpec {
  const kept = reading.observations.filter((o) => o.durationMs >= MIN_DURATION_MS);

  const byRole = new Map<string, RawObservation[]>();
  for (const o of kept) {
    const key = `${o.family} ${o.role}`;
    const list = byRole.get(key) ?? [];
    list.push(o);
    byRole.set(key, list);
  }

  const entries: MotionEntry[] = [];
  for (const [key, group] of byRole) {
    const first = group[0];
    if (first === undefined) continue;
    const durations = group.map((o) => o.durationMs).sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)] ?? 0;
    entries.push({
      family: first.family,
      role: first.role,
      props: [...new Set(group.flatMap((o) => o.props))].sort(),
      durationMs: bucket(median, MOTION_BUCKET_MS),
      staggerMs: staggerFor(group),
      easing: easingFamily(first.easing),
      iterations: first.iterations,
      scrollRatio: first.scrollRatio === null ? null : Math.round(first.scrollRatio * 100) / 100,
      parity: PARITY_FAMILIES.includes(first.family),
      // `key` is deliberately unused past grouping: it carries a NUL and must
      // never reach output.
    });
    void key;
  }

  entries.sort((a, b) =>
    a.family.localeCompare(b.family) ||
    a.role.localeCompare(b.role) ||
    a.props.join().localeCompare(b.props.join()) ||
    a.durationMs - b.durationMs);

  return {
    url: reading.url,
    capturedAt: reading.capturedAt,
    entries,
    libraries: [...reading.libraries].sort(),
    respectsReducedMotion: reading.respectsReducedMotion,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd dashboard/server && npm run build --silent && node --test dist/motion-spec.test.js
```
Expected: PASS, 10/10.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/motion-types.ts dashboard/server/src/motion-spec.ts dashboard/server/src/motion-spec.test.ts
git commit -m "feat(dashboard): a captured duration is stable and a captured start time is not"
```

---

## Task 2: The brief renderer

**Files:**
- Create: `dashboard/server/src/motion-brief.ts`
- Test: `dashboard/server/src/motion-brief.test.ts`

**Interfaces:**
- Consumes: `MotionSpec`, `MotionEntry` from `./motion-types.js` (Task 1 Step 1 — reproduced there verbatim; code against it without waiting).
- Produces: `motionBriefLines(spec: MotionSpec): readonly string[]`, `MOTION_BLOCK_BEGIN`, `MOTION_BLOCK_END`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/server/src/motion-brief.test.ts`:

```typescript
import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { MOTION_BLOCK_BEGIN, MOTION_BLOCK_END, motionBriefLines } from "./motion-brief.js";
import type { MotionEntry, MotionSpec } from "./motion-types.js";

const entry = (over: Partial<MotionEntry> = {}): MotionEntry => ({
  family: "scroll-reveal", role: "div.card", props: ["opacity", "transform"],
  durationMs: 500, staggerMs: 120, easing: "ease-out", iterations: 1,
  scrollRatio: null, parity: true, ...over,
});

const spec = (entries: readonly MotionEntry[]): MotionSpec => ({
  url: "https://example.com", capturedAt: "2026-08-04T00:00:00.000Z",
  entries, libraries: ["gsap"], respectsReducedMotion: true,
});

test("the block is delimited so ticketProse can strip it", () => {
  const lines = motionBriefLines(spec([entry()]));
  strictEqual(lines[0], MOTION_BLOCK_BEGIN);
  strictEqual(lines[lines.length - 1], MOTION_BLOCK_END);
});

test("a parity entry states its numbers", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  match(text, /500ms/);
  match(text, /120ms/);
  match(text, /opacity/);
});

test("a presence-only entry says what was NOT measured", () => {
  const text = motionBriefLines(spec([entry({ family: "canvas-ambient", parity: false })])).join("\n");
  match(text, /not compared/i);
});

test("NO PATH, NO FILENAME, NO ATTACHMENT SENTENCE ever reaches the brief", () => {
  // ticket-refs.ts:26-30 forbids these outright; a criterion written about an
  // artefact the spec seat cannot open grades green or red untraceably.
  const text = motionBriefLines(spec([entry({ role: "/Users/someone/thing.png" })])).join("\n");
  ok(!text.includes("/Users/"));
  ok(!/attach/i.test(text));
});

test("NO ABSOLUTE START TIME can appear, because the type carries none", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  ok(!/start(ed)? at/i.test(text));
});

test("an empty spec renders NOTHING rather than a heading over an empty list", () => {
  // The precedent is outlineLines' omit-an-empty-field rule (ticket-refs.ts:361).
  strictEqual(motionBriefLines(spec([])).length, 0);
});

test("the block names its own limits so the spec seat does not over-author", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  match(text, /automated reading/i);
});

test("reducedMotion is stated when the reference honours it", () => {
  const text = motionBriefLines(spec([entry()])).join("\n");
  match(text, /reduced motion/i);
});

test("rendering is deterministic for the same spec", () => {
  const one = motionBriefLines(spec([entry(), entry({ role: "h1", family: "load-entrance" })]));
  const two = motionBriefLines(spec([entry(), entry({ role: "h1", family: "load-entrance" })]));
  strictEqual(one.join("\n"), two.join("\n"));
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd dashboard/server && npm run build --silent && node --test dist/motion-brief.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `motion-brief.ts`**

```typescript
/**
 * motion-brief.ts — the only words about motion the spec seat ever reads.
 *
 * THE SPEC SEAT IS TEXT ONLY. `bakeoff/src/spec-agent.ts:735` sends the ticket
 * id and the brief between markers and nothing else — no file, no image, no
 * path. So a motion fact that is not in these lines does not exist as far as the
 * acceptance suite is concerned.
 *
 * EVERY LINE HERE ENTERS `ticket.sha256`. That is why this module is pure, why
 * it renders in a fixed order, and why it prints nothing at all for an empty
 * spec rather than a heading above an empty list — `outlineLines` sets that
 * precedent for exactly the same reason.
 *
 * THE PARITY/PRESENCE SPLIT IS SAID OUT LOUD. Two families can only be observed
 * to exist, never compared, and a brief that read the same for both would invite
 * the spec seat to author a criterion nothing can check.
 */
import type { MotionEntry, MotionSpec } from "./motion-types.js";

export const MOTION_BLOCK_BEGIN = "--- MOTION READ FROM THE REFERENCE PAGE (BEGIN) ---";
export const MOTION_BLOCK_END = "--- MOTION READ FROM THE REFERENCE PAGE (END) ---";

const FAMILY_PROSE: Record<string, string> = {
  "load-entrance": "on load, entering",
  "scroll-reveal": "revealed once on scroll into view",
  "scroll-linked": "driven by scroll position rather than by time",
  "hover-focus": "on hover and on keyboard focus",
  "ambient-loop": "looping continuously with no trigger",
  "split-text": "per-character, staggered",
  "path-draw": "an SVG stroke drawing itself",
  "scroll-inertia": "smooth-scroll inertia on the document",
  "cursor-follow": "following the pointer",
  "tilt-3d": "tilting in 3D toward the pointer",
  "route-transition": "between routes",
  "canvas-ambient": "a canvas or WebGL surface repainting continuously",
};

function entryLine(entry: MotionEntry): string {
  const parts: string[] = [`  ${entry.role} — ${FAMILY_PROSE[entry.family] ?? entry.family}`];
  if (entry.props.length > 0) parts.push(`animating ${entry.props.join(" and ")}`);
  if (entry.parity) {
    parts.push(`over ${String(entry.durationMs)}ms`);
    if (entry.easing !== null) parts.push(`(${entry.easing})`);
    if (entry.staggerMs !== null) parts.push(`, ${String(entry.staggerMs)}ms apart across siblings`);
    if (entry.scrollRatio !== null) parts.push(`, moving ${entry.scrollRatio.toFixed(2)}px per px scrolled`);
    if (entry.iterations === null) parts.push(", repeating without end");
  } else {
    parts.push("— presence only: this was observed to run, and its content was NOT compared");
  }
  return parts.join(" ");
}

export function motionBriefLines(spec: MotionSpec): readonly string[] {
  if (spec.entries.length === 0) return [];
  const lines: string[] = [
    MOTION_BLOCK_BEGIN,
    "",
    "This is a partial, automated reading of how a reference page MOVES, taken once",
    "when the ticket was submitted by sampling the rendered page frame by frame. It is",
    "not the page and it is not complete: motion it does not mention may still exist.",
    "",
    "Durations are rounded to the nearest 50ms and stagger to the nearest 20ms, because",
    "an exact measurement differs between two readings of the same page.",
    "",
    "The motion observed:",
  ];
  for (const entry of spec.entries) lines.push(entryLine(entry));
  if (spec.libraries.length > 0) {
    lines.push("", `Motion libraries detected on the reference: ${spec.libraries.join(", ")}.`,
      "This names what the reference used. It is not an instruction to use the same one.");
  }
  lines.push("", spec.respectsReducedMotion
    ? "The reference honours prefers-reduced-motion. Anything built from it must too."
    : "The reference does NOT honour prefers-reduced-motion. Anything built from it still must.");
  lines.push("", MOTION_BLOCK_END);
  return lines;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd dashboard/server && npm run build --silent && node --test dist/motion-brief.test.js
```
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/motion-brief.ts dashboard/server/src/motion-brief.test.ts
git commit -m "feat(dashboard): motion becomes words a text-only seat can grade, or it becomes nothing"
```

---

## Task 3: The guessed-parent fix

**Files:**
- Modify: `dashboard/server/src/graph-emit.ts:169-174`
- Test: `dashboard/server/src/graph-emit.test.ts`

**Interfaces:**
- Consumes: nothing. Fully independent of the motion work.
- Produces: nothing other tasks use.

Context: on run `…052c6e02`, 21 of 34 `graph_agent` events were `inferred` against 13 `exact`. An inferred edge is parented to ROOT, so a subagent that delegates further is drawn hanging off the orchestrator — the canvas shows a flat fan where there was a chain. `canSpawn` refusing an unrecognised delegation shape is the prime suspect.

- [ ] **Step 1: Measure the actual cause before changing anything**

```bash
cd /Users/kamilborzecki/Projects/coding-agent
node -e "
const {readFileSync}=require('node:fs');
const f='dashboard/data/runs.db';
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(f,{readOnly:true});
const rows=db.prepare(\"SELECT payload FROM events WHERE run_id LIKE '%052c6e02' AND payload LIKE '%graph_agent%'\").all();
let nullId=0, unseen=0, total=0;
for(const r of rows){ const p=JSON.parse(r.payload); if(p.type!=='graph_agent')continue; total++;
  if(p.attribution==='inferred'){ if(!p.toolUseId) nullId++; else unseen++; } }
console.log({total,nullId,unseen});
"
```
Record the numbers in the commit body. If `nullId` dominates, the cause is cause 1 (payload arrives without an id) and widening `canSpawn` will NOT help — stop and report rather than shipping a fix for the wrong cause.

- [ ] **Step 2: Write the failing test**

Append to `dashboard/server/src/graph-emit.test.ts`:

```typescript
test("a delegation shaped as neither Agent nor Task is still recorded as a spawn origin", () => {
  // THE DEFECT: canSpawn matched only the two names, else required
  // `subagent_type` or `isolation` in the input. Any other delegation shape was
  // never recorded, so every task it spawned was parented to ROOT and drawn as
  // a guess. 21 of 34 spawns on run …052c6e02.
  const projection = new GraphProjection();
  const out: GraphEvent[] = [];
  projection.assistant({ uses: [{ id: "tu_1", name: "Dispatch", input: { agent_type: "code-reviewer" } }] }, out);
  projection.taskStarted({ task_id: "t1", tool_use_id: "tu_1", subagent_type: "code-reviewer" }, out);
  const agent = out.find((e) => e.type === "graph_agent");
  strictEqual(agent?.attribution, "exact");
});

test("NEGATIVE CONTROL: a tool use that is NOT a delegation is still never a spawn origin", () => {
  // Without this the fix could be 'return true' and every test above would pass.
  const projection = new GraphProjection();
  const out: GraphEvent[] = [];
  projection.assistant({ uses: [{ id: "tu_2", name: "Read", input: { file_path: "/x" } }] }, out);
  projection.taskStarted({ task_id: "t2", tool_use_id: "tu_2", subagent_type: null }, out);
  const agent = out.find((e) => e.type === "graph_agent");
  strictEqual(agent?.attribution, "inferred");
});
```

Adjust the constructor and method names to whatever `graph-emit.test.ts` already uses — read the file's existing tests first and copy their idiom exactly.

- [ ] **Step 3: Run to verify it fails**

```bash
cd dashboard/server && npm run build --silent && node --test dist/graph-emit.test.js
```
Expected: FAIL on the first test, PASS on the negative control.

- [ ] **Step 4: Widen `canSpawn`**

Replace `dashboard/server/src/graph-emit.ts:169-174` with:

```typescript
/**
 * Does this tool use delegate work to another agent?
 *
 * WIDENED 2026-08-04, AND THE REASON IS A MEASUREMENT. On run …052c6e02 this
 * function's answer decided 21 of 34 spawns, and every "no" it returned turned a
 * real parent edge into a guess parented to the root — so the canvas drew a flat
 * fan where the run had a chain. Matching two literal names and two literal
 * input keys was too narrow for the delegation shapes actually on the wire.
 *
 * THE NEGATIVE CONTROL IS THE POINT. Widening to "anything with an input" would
 * make every Read a spawn origin and every subsequent task inherit a wrong
 * parent CONFIDENTLY — worse than the guess it replaced, because the dashed edge
 * at least says it is guessing. `graph-emit.test.ts` pins both directions.
 */
function canSpawn(use: GraphToolUse): boolean {
  if (DELEGATION_NAMES.has(use.name)) return true;
  const input = use.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  return DELEGATION_KEYS.some((key) => key in input);
}

/** Names that delegate, whatever their input looks like. */
const DELEGATION_NAMES = new Set(["Agent", "Task", "Dispatch", "SendMessage", "Workflow"]);

/** Input keys that mean "this call runs something else on my behalf". */
const DELEGATION_KEYS: readonly string[] = ["subagent_type", "isolation", "agent_type", "agentType"];
```

- [ ] **Step 5: Run the full server suite**

```bash
cd dashboard/server && npm run build --silent && node --test "dist/**/*.test.js" 2>&1 | tail -8
```
Expected: the two new tests pass; `fail 0`. Calibration will fail if docker is down — that is unrelated and expected; confirm `docker version` answers before treating any calibration failure as yours.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/graph-emit.ts dashboard/server/src/graph-emit.test.ts
git commit -m "fix(dashboard): 21 of 34 spawns were guesses because canSpawn knew two names"
```

---

## Task 4: The third provenance bucket

**Files:**
- Modify: `dashboard/server/src/spec-assumptions.ts:104` and `:107`
- Test: `dashboard/server/src/spec-assumptions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AssumptionSource` gains `"reference"`. Task 8 sets it.

- [ ] **Step 1: Read the four existing sources and their docblocks**

```bash
sed -n '80,130p' dashboard/server/src/spec-assumptions.ts
```
`answered` was added as a fourth case and its docblock explains why a fourth existed; the fifth follows that shape exactly.

- [ ] **Step 2: Write the failing test**

Append to `dashboard/server/src/spec-assumptions.test.ts`:

```typescript
test("a fact taken from the owner's reference is neither his words nor a guess", () => {
  // Without a fifth source the tracer stamps every motion criterion INFERRED —
  // orchestrator.ts:2679 feeds it ticketProse(stripPlanBlock(brief)), which
  // strips the captured block back off before matching. The feature would move
  // its own headline metric the wrong way and escalate the run log to warn.
  strictEqual(ownerSourced("reference"), true);
});

test("NEGATIVE CONTROL: inferred is still not owner-sourced", () => {
  strictEqual(ownerSourced("inferred"), false);
  strictEqual(ownerSourced("default"), false);
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd dashboard/server && npm run build --silent && node --test dist/spec-assumptions.test.js
```
Expected: FAIL — `"reference"` is not assignable to `AssumptionSource`.

- [ ] **Step 4: Add the source**

At `spec-assumptions.ts:104`:

```typescript
export type AssumptionSource = "ticket" | "inferred" | "default" | "answered" | "reference";
```

Above it, extend the docblock with:

```
 * `reference` is the owner's too, at one remove. He chose the page; a duration
 * read off it is a fact he supplied without being a sentence he typed. Folding
 * it into `ticket` would credit him with a number he never saw; folding it into
 * `inferred` would call his own reference a guess by the grader. Both are lies
 * in opposite directions, so it gets its own name — the same argument that
 * earned `answered` its own case.
```

Then include it in `ownerSourced` at `:107`.

- [ ] **Step 5: Run to verify it passes, and check every switch over the union**

```bash
cd dashboard/server && npm run build --silent 2>&1 | head -20 && node --test dist/spec-assumptions.test.js
```
Expected: PASS. If `tsc` reports a non-exhaustive switch anywhere, fix it there rather than adding a default branch — the compiler error is the feature.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/spec-assumptions.ts dashboard/server/src/spec-assumptions.test.ts
git commit -m "feat(dashboard): a fact from your reference is not a guess and is not your sentence"
```

---

## Task 5: The form control and the notice that is now false

**Files:**
- Modify: `dashboard/src/app/page.tsx` — state at :175-183, panel in the gap at :610-638, `createRun` body at :337-344, notice at :560-567
- Test: `dashboard/tests/ticket-motion.browser.spec.ts` (create)

**Interfaces:**
- Consumes: nothing at build time. The wire field name is `motionUrl` (string | null | absent).
- Produces: the POST body carries `motionUrl` only when non-empty.

- [ ] **Step 1: Read the existing Design panel and copy its idiom exactly**

```bash
sed -n '639,700p' dashboard/src/app/page.tsx
```

- [ ] **Step 2: Write the failing browser test**

Create `dashboard/tests/ticket-motion.browser.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";

test("an empty motion field sends NO motionUrl key at all", async ({ page }) => {
  // Five existing specs assert the whole POST body with toEqual
  // (model-picker.browser.spec.ts:196). An unconditional key reddens all five.
  let body: unknown = null;
  await page.route("**/api/runs", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { runId: "run-x" } });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: /ticket/i }).fill("build me a thing");
  await page.getByRole("button", { name: /start run/i }).click();
  expect(body).not.toHaveProperty("motionUrl");
});

test("a filled motion field reaches the wire", async ({ page }) => {
  let body: Record<string, unknown> = {};
  await page.route("**/api/runs", async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, json: { runId: "run-x" } });
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: /ticket/i }).fill("build me a thing");
  await page.getByLabel(/motion reference/i).fill("https://example.com");
  await page.getByRole("button", { name: /start run/i }).click();
  expect(body["motionUrl"]).toBe("https://example.com");
});

test("the form no longer promises there is never a comparison against the live page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: /ticket/i }).fill("copy https://example.com");
  await expect(page.getByText(/never a comparison against the live page/i)).toHaveCount(0);
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd dashboard && npx playwright test tests/ticket-motion.browser.spec.ts --project=browser
```
Expected: FAIL — no motion field, and the old notice still present.

- [ ] **Step 4: Add the state hook**

In the `useState` block at `page.tsx:175-183`:

```typescript
const [motionUrl, setMotionUrl] = useState("");
```

- [ ] **Step 5: Add the panel in the gap between Ticket and Design (line ~610)**

```tsx
{/*
  * A LINK WHOSE MOTION IS WANTED AND WHOSE CONTENT IS NOT. The brief's own first
  * URL still means "copy this site" and still feeds the outline capture; this one
  * means only "move like this". Keeping them apart is what lets the owner say he
  * likes how something moves without inheriting its headings and its palette.
  *
  * NO VALIDATION HERE, DELIBERATELY. The server owns the refusal list
  * (site-capture.ts:185 refuses localhost, private and link-local ranges) and a
  * second copy on the client would drift from it. This field's job is to carry
  * the string; the run's log says what happened to it.
  */}
<Panel title="Motion reference">
  <label className="flex flex-col gap-1.5">
    <span className="text-[13px] font-medium text-ink">
      A page whose animation you want matched
    </span>
    <input
      type="url"
      inputMode="url"
      placeholder="https://…"
      value={motionUrl}
      onChange={(event) => setMotionUrl(event.target.value)}
      className="w-full rounded border border-line bg-transparent px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-faint"
    />
  </label>
  <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">
    Read once when the ticket is submitted, by opening the page and watching it move.
    Only the motion is taken — not the words, the layout or the colours. Durations are
    rounded, because two readings of the same page never agree exactly.
  </p>
</Panel>
```

- [ ] **Step 6: Add the field to the request, conditionally**

At `page.tsx:337-344`, following the existing spread convention:

```typescript
...(motionUrl.trim() === "" ? {} : { motionUrl: motionUrl.trim() }),
```

- [ ] **Step 7: Rewrite the false notice at :560-567**

Replace the sentence *"and never a comparison against the live page"* with:

```tsx
The first link in this brief is captured before the suite is written — an outline
into the ticket text and screenshots for the builder. The page itself is never
reachable at grading time; what is compared is the build against numbers taken
from it now.
```

- [ ] **Step 8: Run the tests**

```bash
cd dashboard && npx playwright test tests/ticket-motion.browser.spec.ts --project=browser
cd dashboard && npx playwright test tests/model-picker.browser.spec.ts --project=browser
```
Expected: both PASS. The second is the regression that matters — the whole-body `toEqual` assertions must be untouched.

- [ ] **Step 9: Commit**

```bash
git add dashboard/src/app/page.tsx dashboard/tests/ticket-motion.browser.spec.ts
git commit -m "feat(dashboard): a page you like the movement of, and the promise the form could no longer keep"
```

---

## Task 6: The capture driver, and a real browser behind it

**Files:**
- Create: `dashboard/server/src/motion-capture.ts`
- Create: `dashboard/server/src/motion-capture.test.ts`
- Create: `dashboard/server/src/motion-capture.browser.test.ts`
- Create: `dashboard/server/src/test-fixtures/motion-fixture.html`

**Interfaces:**
- Consumes: `MotionReading`, `RawObservation`, `MotionCaptureResult` from `./motion-types.js`.
- Produces: `captureMotion(options: MotionCaptureOptions): Promise<MotionCaptureResult>`, `MOTION_BUDGET_MS`, `LaunchMotionBrowser`.

**Read first:** `dashboard/server/src/site-capture.ts:255-400`. This task mirrors its seam shape (`LaunchBrowser`, `CaptureOptions.launch`, never-throws contract, browser closed on every path) and must not diverge from it without saying why in a docblock.

- [ ] **Step 1: Create the fixture with KNOWN declared numbers**

Create `dashboard/server/src/test-fixtures/motion-fixture.html` with a hero entrance of exactly 800 ms, three cards revealing at 500 ms with a 120 ms stagger, an infinite 3000 ms ambient loop, a 250 ms hover transition, and a parallax written from `requestAnimationFrame` at 0.25 px per px scrolled. Use the fixture already validated in this session at `scratchpad/fixture/index.html`; copy it verbatim.

- [ ] **Step 2: Write the failing real-browser test**

Create `dashboard/server/src/motion-capture.browser.test.ts`:

```typescript
import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { captureMotion } from "./motion-capture.js";
import { normaliseMotion } from "./motion-spec.js";

const fixture = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "test-fixtures", "motion-fixture.html")).href;

test("REAL CHROMIUM: the declared 800ms hero entrance is measured within a bucket", async () => {
  // site-capture.ts:50-55 records that nothing in that file was ever run against
  // a real browser. This is the test that file never had. Measured this session:
  // host 796ms, sealed container 799ms, against a declared 800ms.
  const result = await captureMotion({ url: fixture });
  ok(result.ok, result.ok ? "" : result.reason);
  const spec = normaliseMotion(result.reading);
  const hero = spec.entries.find((e) => e.family === "load-entrance" && e.role.startsWith("h1"));
  strictEqual(hero?.durationMs, 800);
});

test("REAL CHROMIUM: a page with animations disabled reports NO motion", async () => {
  // THE NEGATIVE CONTROL. The sealed scorer's existing capture runs
  // reducedMotion:"reduce" + animations:"disabled" (scorer-container.ts:633,678)
  // and measures exactly zero. A probe that cannot return zero when there IS
  // none is a probe that can only observe success. Without this test, a capture
  // wired to the wrong context options looks identical to a working one.
  const result = await captureMotion({ url: fixture, forceReducedMotion: true });
  ok(result.ok, result.ok ? "" : result.reason);
  const spec = normaliseMotion(result.reading);
  strictEqual(spec.entries.filter((e) => e.family === "load-entrance").length, 0);
});

test("REAL CHROMIUM: two captures of the same page produce an IDENTICAL spec", async () => {
  // The determinism gate. If this fails, every resubmission of the same ticket
  // mints a new id and re-authors the acceptance suite on the owner's quota.
  // This is also what calibrates STAGGER_BUCKET_MS: widen it until this passes.
  const a = await captureMotion({ url: fixture });
  const b = await captureMotion({ url: fixture });
  ok(a.ok && b.ok);
  const one = normaliseMotion(a.reading);
  const two = normaliseMotion(b.reading);
  strictEqual(
    JSON.stringify({ ...one, capturedAt: "" }),
    JSON.stringify({ ...two, capturedAt: "" }));
});

test("REAL CHROMIUM: scroll-linked motion is told apart from time-driven motion", async () => {
  // getAnimations() reports NOTHING for this — measured on gsap.com: 0 running
  // animations at every one of six scroll offsets. It is found only by sampling.
  const result = await captureMotion({ url: fixture });
  ok(result.ok);
  const spec = normaliseMotion(result.reading);
  const parallax = spec.entries.find((e) => e.family === "scroll-linked");
  strictEqual(parallax?.scrollRatio, 0.25);
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd dashboard/server && npm run build --silent && node --test dist/motion-capture.browser.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `motion-capture.ts`**

Requirements the implementation must satisfy, each of which has a test above:

1. **Never throws.** Every failure returns `{ok: false, reason}` — a slow third-party page must not refuse to create a run. Copy `captureSite`'s contract and its browser-closed-on-every-path guarantee.
2. **Installs the sampler with `addInitScript`, before page scripts run.** Measured: 21 moving elements versus 5 for a sampler that starts at `domcontentloaded`.
3. **Samples computed style per animation frame in-page**, never `document.getAnimations()`. Measured: gsap.com reports 0 running animations at every scroll offset.
4. **Opens its context at `reducedMotion: "no-preference"`**, and honours `forceReducedMotion` for the negative control.
5. **Every playwright call takes an explicit timeout**, and `MOTION_BUDGET_MS` equals their sum. `site-capture.test.ts:238-251` sets the precedent of asserting the exact count and sum; write the equivalent assertion in `motion-capture.test.ts`.
6. **The seam is injected** — `MotionCaptureOptions.launch?: LaunchMotionBrowser` — so `motion-capture.test.ts` exercises the failure modes with no browser.
7. **Phases:** load entrance (2.5 s) → ambient (1.5 s idle) → scroll ramp at six offsets with time held → hover over the first six interactive elements → a second context at `reducedMotion: "reduce"` to answer `respectsReducedMotion`.

Use the validated sampler from this session at `scratchpad/sample-both.mjs` as the starting point for the in-page script; it has been run on the host and inside `bakeoff-scorer:1`.

- [ ] **Step 5: Write the seam tests**

`motion-capture.test.ts` must cover, each against an injected fake: launch failure, navigation timeout, an `evaluate` that throws, a page returning zero observations, and the exact-timeout-count assertion from requirement 5.

- [ ] **Step 6: Run both test files**

```bash
cd dashboard/server && npm run build --silent && node --test dist/motion-capture.test.js dist/motion-capture.browser.test.js
```
Expected: PASS. If the determinism test fails, widen `STAGGER_BUCKET_MS` in `motion-spec.ts` and record the measured wobble in the commit body — do not loosen the assertion.

- [ ] **Step 7: Commit**

```bash
git add dashboard/server/src/motion-capture.ts dashboard/server/src/motion-capture.test.ts dashboard/server/src/motion-capture.browser.test.js dashboard/server/src/test-fixtures/
git commit -m "feat(dashboard): watch the page move, because asking it what moves returns nothing"
```

---

## Task 7: The client mirror and the parity test

**Files:**
- Modify: `dashboard/src/lib/api-types.ts` — `CreateRunRequest` (~:852), `RunDetail` (:553-718)
- Modify: `dashboard/server/src/api-types.ts` — `CreateRunRequest` (:1764), `RunDetail`
- Modify: `dashboard/server/src/contract-parity.test.ts` — `DETAIL_SHAPES` (:687-708)

**Interfaces:**
- Consumes: nothing at run time.
- Produces: `RunDetail.motion: ApiMotionSpec | null` and `CreateRunRequest.motionUrl?: string | null`, both declared identically in both packages.

- [ ] **Step 1: Read why this task exists**

```bash
sed -n '591,659p' dashboard/server/src/contract-parity.test.ts
```
`references`/`documents` shipped on 2026-08-02 with the suite at 1165/1163 green and never rendered, because the client mirror was not hand-updated. A field added to only one side compiles clean on both.

- [ ] **Step 2: Write the failing parity assertion first**

Add `motion` to the hardcoded `RunDetail` field list in `DETAIL_SHAPES` at `:687-708`, and add a `{server, client, fields}` entry for `ApiMotionSpec`. Run:

```bash
cd dashboard/server && npm run build --silent && node --test dist/contract-parity.test.js
```
Expected: FAIL — the field is in the list and in neither package.

- [ ] **Step 3: Declare the type in both packages, identically**

```typescript
/** A reading of how a reference page moves. Mirrors MotionSpec, minus the raw. */
export interface ApiMotionSpec {
  readonly url: string;
  readonly capturedAt: string;
  readonly entries: readonly ApiMotionEntry[];
  readonly libraries: readonly string[];
  readonly respectsReducedMotion: boolean;
}

export interface ApiMotionEntry {
  readonly family: string;
  readonly role: string;
  readonly props: readonly string[];
  readonly durationMs: number;
  readonly staggerMs: number | null;
  readonly easing: string | null;
  readonly iterations: number | null;
  readonly scrollRatio: number | null;
  readonly parity: boolean;
}
```

Note the parser hazard: `fieldNames` (`contract-parity.test.ts:436`) closes on the FIRST `}` after the anchor, so keep both interfaces flat — no inlined object literals, no unions inside a member.

- [ ] **Step 4: Add a count assertion so a half-parsed shape cannot pass silently**

Follow the `DesignLockState` precedent at `contract-parity.test.ts:227-231`: assert `ApiMotionEntry` has exactly 9 fields.

- [ ] **Step 5: Run**

```bash
cd dashboard/server && npm run build --silent && node --test dist/contract-parity.test.js
cd dashboard && npx tsc --noEmit
```
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/api-types.ts dashboard/server/src/api-types.ts dashboard/server/src/contract-parity.test.ts
git commit -m "feat(dashboard): the motion shape exists on both sides of the wire this time"
```

---

## Task 8: Server wiring — identity, manifest, brief, intake

**Files:**
- Modify: `dashboard/server/src/ticket.ts:145` (`TicketReferences`), `:217` (`ticketWithReferences`), `:269` (`ticketFromStoredReferences`)
- Modify: `dashboard/server/src/ticket-refs.ts:186` (`ReferenceManifest`), `:293` (`hasReferences`), `:327` (`composeBrief`), `:346` (`ticketProse`), `:508`/`:567` (prompt sections), `referenceIdentityMaterial`
- Modify: `dashboard/server/src/http.ts:395`, `:1701`, `:1785`, `:1923-1934`, `:2006`, `:2034`
- Test: `dashboard/server/src/ticket-refs.test.ts`, `dashboard/server/src/api-references.test.ts`

**Interfaces:**
- Consumes: `normaliseMotion` (Task 1), `motionBriefLines` + `MOTION_BLOCK_BEGIN`/`END` (Task 2), `captureMotion` (Task 6), `ApiMotionSpec` (Task 7).
- Produces: nothing later tasks consume.

**This is one task and one commit** because the four files interlock: an id folded in at intake that is not read back at build time authors a second suite silently, and `ticket-refs.test.ts` pins a hardcoded golden id that catches exactly that.

- [ ] **Step 1: Write the failing identity tests**

Append to `dashboard/server/src/ticket-refs.test.ts`:

```typescript
test("THE GOLDEN ID IS UNCHANGED when no motion is captured", () => {
  // referenceIdentityMaterial must return the brief unchanged when there are no
  // images, no documents AND no motion. A silent id change orphans every frozen
  // suite on disk.
  const before = ticketWithReferences({ prose: "build a thing", images: [], capture: null });
  strictEqual(before.id, "<paste the existing golden id from this file>");
});

test("a captured motion spec CHANGES the ticket id", () => {
  const without = ticketWithReferences({ prose: "p", images: [], capture: null });
  const with_ = ticketWithReferences({ prose: "p", images: [], capture: null, motion: SPEC });
  ok(without.id !== with_.id);
});

test("intake and read-back derive the SAME id", () => {
  // ticket.ts:278-288 records this exact defect class shipping once already:
  // it does not fail to compile, does not throw, and authors a second suite.
  const atIntake = ticketWithReferences({ prose: "p", images: [], capture: null, motion: SPEC });
  const onReadBack = ticketFromStoredReferences(atIntake.brief, { images: [], capture: null, motion: SPEC });
  strictEqual(onReadBack.id, atIntake.id);
});

test("sha256 stays exactly ticketDigest(brief), motion or not", () => {
  const ticket = ticketWithReferences({ prose: "p", images: [], capture: null, motion: SPEC });
  strictEqual(ticket.sha256, ticketDigest(ticket.brief));
});

test("ticketProse strips the MOTION block as well as the capture block", () => {
  // classifySurface reads the brief; a captured motion vocabulary would
  // otherwise flip the surface classification and pick a different lane.
  const ticket = ticketWithReferences({ prose: "build a thing", images: [], capture: null, motion: SPEC });
  strictEqual(ticketProse(ticket.brief), "build a thing");
});

test("NEGATIVE CONTROL: a motion spec with no entries composes NO block", () => {
  const empty = { ...SPEC, entries: [] };
  const ticket = ticketWithReferences({ prose: "p", images: [], capture: null, motion: empty });
  ok(!ticket.brief.includes("MOTION READ FROM"));
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd dashboard/server && npm run build --silent && node --test dist/ticket-refs.test.js
```

- [ ] **Step 3: Thread `motion` through the four files**

Order matters: `ReferenceManifest` → `TicketReferences` → `referenceIdentityMaterial` → `composeBrief` → `ticketProse` → `ticketFromStoredReferences` → the two prompt sections → `hasReferences`.

`ticketProse` currently finds `brief.lastIndexOf("\n" + CAPTURE_BLOCK_BEGIN)`. With two blocks it must cut at the EARLIER of the two begin markers present, or the owner's prose keeps the first block. Write that as its own test case before changing it.

`hasReferences` gates both prompt sections and printing "READ EACH ONE BEFORE ACTING" above an empty list is the failure the existing `shots.length > 0` guards at `:518`/`:574` already prevent — widen it and add the matching non-empty block in the same edit.

- [ ] **Step 4: Wire the intake in `http.ts`**

- `HttpDeps.captureMotion?` beside `captureSite` at `:395`.
- `motionUrl` read at `:1785`, validated `string | null | absent` with its own message, reusing `captureTargetFor` for the refusal list so localhost and private ranges are refused identically.
- `runMotionCapture` modelled on `runCapture` at `:2006` — never throws, returns a named decline.
- Called between `:1923` and `:1926`, so its result is in hand BEFORE `ticketWithReferences` fixes identity.
- Written into the manifest at `:1934`.
- A line in `captureNotes` at `:2034` naming success or the decline, at `warn` for a decline.

- [ ] **Step 5: Run the full server suite**

```bash
cd dashboard/server && npm run clean && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|cancelled|skipped)"
```
Expected: `fail 0`. Baseline before this plan started: 1502 tests / 1491 pass / 0 fail / 8 cancelled (calibration, docker) / 3 skipped. The count rises; `fail` stays 0.

- [ ] **Step 6: Commit**

```bash
git add dashboard/server/src/ticket.ts dashboard/server/src/ticket-refs.ts dashboard/server/src/http.ts dashboard/server/src/ticket-refs.test.ts dashboard/server/src/api-references.test.ts
git commit -m "feat(dashboard): the motion you referenced is part of what the ticket IS"
```

---

## Task 9: End-to-end verification against a real site

**Files:** none modified. This task produces a report, and a decision about Plan B.

- [ ] **Step 1: Start the dashboard and submit a real ticket**

```bash
cd dashboard/server && npm start &
cd dashboard && npm run dev &
```
Submit a ticket with a motion reference of a genuinely animated public site.

- [ ] **Step 2: Read the composed brief, not a summary of it**

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('dashboard/data/runs.db',{readOnly:true});
const row=db.prepare('SELECT ticket_text FROM runs ORDER BY created_at DESC LIMIT 1').get();
console.log(row.ticket_text);
"
```

- [ ] **Step 3: Answer the three questions Plan B depends on**

1. Does the motion block describe motion a person would recognise on that page?
2. Submitting the same ticket twice — is the ticket id identical?
3. Are the entries specific enough to be worth enforcing, or is the spec mostly `div.something — revealed once on scroll`?

- [ ] **Step 4: Record the answers in the spec's §11 and stop**

Plan B does not start until a human has read a real captured spec. If question 3's answer is "mostly noise", the fix is in `motion-spec.ts`'s role naming, and it is far cheaper to find here than after a gate is written against it.

---

## Self-Review

**Spec coverage.** §4 five units → T1 (types+spec), T2 (brief), T6 (capture); `motion-probe.ts`/`motion-compare.ts` are Plan B by §4.1. §5 determinism → T1 tests + T6 Step 6. §6 provenance → T4. §7 negative controls 1 and 4 → T6 Steps 2; controls 2, 3 and 5 are Plan B (calibration fixtures). §8 hazards → T5 (spread + notice), T7 (mirror + parser), T8 (identity, `ticketProse`, `hasReferences`, budgets). Guessed-parent → T3.

**Gap, stated rather than hidden:** §7's control 5 ("a plan with no baseline emits NO motion gate") cannot be tested in Plan A — there is no gate yet. It is carried into Plan B.

**Type consistency.** `MotionSpec`/`MotionEntry`/`RawObservation`/`MotionReading`/`MotionCaptureResult` are declared once in T1 Step 1 and used unchanged in T2, T6, T7, T8. `ApiMotionSpec`/`ApiMotionEntry` are the wire mirrors and are deliberately separate types.

**Placeholder scan.** T6 Step 4 states requirements rather than a code block — deliberate, and the only one: the in-page sampler is 120 lines of validated script already on disk at `scratchpad/sample-both.mjs`, and copying it into a plan document would guarantee the two drift. Every other step carries its content.

---

## Carried forward — open, measured, and not fixed

### C1. `verdict.md` recomputes the assumptions and disagrees with `assumptions.md`

**Measured 2026-08-04** while closing Task 4's real gap (the `reference` bucket
was set by nothing until commit `2eb4b5c`).

`run-report.ts:verdictInputFor` builds its own assumption set from the criteria
alone: it passes NEITHER the plan phase's answered pairs (pre-existing, since
2026-08-02) NOR the motion reading (new). So for any run with a plan phase or a
motion reference, the verdict's headline sentence — "N of M criteria were
inferred rather than stated in your ticket" — counts as the grader's guesses
things that `assumptions.md` and `RunDetail.inferredCriteria` credit to the
owner. Measured shape: record says 1 of 2 inferred, page says 2 of 2.

Half of the defect IS fixed (commit `6178a49`): the page was also tracing
against the STORED brief with the machine-written blocks still in it, so it told
the owner `you wrote: "The motion observed: h1 — on load, entering animating
opacity over 800ms"` — a sentence this repository composed. Both paths now trace
through the one exported `tracedProse`.

**Why the rest is not fixed here.** Threading the two inputs into
`writeRunVerdict` is a one-line change; PROVING the orchestrator threads them is
not. `verdictPageFor` renders the no-verdict page for every run these harnesses
can produce — a cancelled run takes that arm unconditionally, and every
non-docker run ends with its criteria still `pending` — so no orchestrator-driven
test can read a scored page and no mutation at that call site would go red.
Shipping a call site no test can observe is precisely the defect `2eb4b5c`
closed, one door along.

**What unblocks it:** either a harness that reaches a scored verdict without
docker (seeded criterion results plus a terminal status that is not
`cancelled`), or an assertion surface on the no-verdict page that carries the
inferred count. Do that first, then thread the parameters.
