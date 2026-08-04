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
