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
 *
 * WHAT THIS FILE DOES NOT DO. It passes `capturedAt` through unchanged. That is
 * a timestamp, so it differs between two readings of the same page, and a caller
 * that hashes a whole `MotionSpec` re-mints the ticket id on every resubmission
 * — the exact failure the rest of this file exists to prevent. Nothing here can
 * stop that; only the caller's choice of what to hash can.
 */
import type { MotionEntry, MotionReading, MotionSpec, RawObservation } from "./motion-types.js";
import { PARITY_FAMILIES } from "./motion-types.js";

export const MOTION_BUCKET_MS = 50;
export const STAGGER_BUCKET_MS = 20;

/** A change with no duration is a state flip — a dropdown snapping open. */
const MIN_DURATION_MS = 1;

const bucket = (value: number, size: number): number => Math.round(value / size) * size;

/**
 * Four named curves — `linear`, `ease-in`, `ease-out`, `ease-in-out` — plus
 * `null` for anything unrecognised. Every `cubic-bezier(...)` collapses into one
 * of the four by its two x controls, because a raw
 * `cubic-bezier(0.16, 1, 0.3, 1)` differs from `cubic-bezier(0.17, 1, 0.29, 1)`
 * by nothing a visitor could see and by enough bytes to mint a new ticket.
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

  // Grouped by family AND role, because the same element can carry two kinds of
  // motion — a card that reveals on scroll and also lifts on hover — and folding
  // those together would average two unrelated durations into one that describes
  // neither. No family contains a space, so the joined key parses back
  // unambiguously; nothing downstream reads it, and the entry recovers both
  // halves from the group's first observation instead.
  const byRole = new Map<string, RawObservation[]>();
  for (const o of kept) {
    const key = `${o.family} ${o.role}`;
    const list = byRole.get(key) ?? [];
    list.push(o);
    byRole.set(key, list);
  }

  const entries: MotionEntry[] = [];
  for (const group of byRole.values()) {
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
    });
  }

  // SORTED ON THE ENTRY'S OWN FIELDS, never on insertion order: the sampler
  // reports whatever fired first, which is the one thing measured to differ
  // between two readings of the same page.
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
