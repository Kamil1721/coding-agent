/**
 * WHAT GETS ANIMATED, AND HOW MANY TIMES — the cost control of spec §7.6.3.2.
 *
 * "Bounded by default: at most 2 video legs per run… Raising it is a per-run,
 * recorded opt-in." A video leg is the most expensive call this system makes —
 * it spends cash on a metered key rather than subscription quota, and it takes
 * minutes rather than seconds — so the bound is enforced TWICE, once when the
 * plan is built and once at the seam that actually invokes the script, and each
 * is proven by COUNTING INVOCATIONS rather than by reading the plan back. A cap
 * you have only ever read back is a comment: `plan.cap === 2` is equally true of
 * a planner that emitted five legs.
 *
 * THE MANIFEST IS PARSED, NOT TYPED FROM `DesignManifest`. `visual-criteria.ts`
 * :58-68 says in as many words that Phase 2b owns that type and that a second
 * declaration site would be a merge conflict with a wrong answer in it. This
 * module reads the on-disk JSON tolerantly instead: no `animate` anywhere means
 * no legs, which is exactly the degraded state a pre-2b manifest should produce.
 *
 * THE OPT-IN IS AN ENV VAR AND NOT A REQUEST FIELD, deliberately. §7.6.3.2 asks
 * for a per-run recorded opt-in; a field on `POST /api/runs` would be a fifth
 * declaration site in a frozen contract (`api-types.ts`, its client mirror, the
 * event-type tables and `contract-parity.test.ts`), which belongs to whichever
 * phase widens that route. `DASHBOARD_VIDEO_LEG_CAP` is read once per run and
 * written into `results/video.json` beside the number it produced.
 */
import type { VideoCapability } from "./video-capability.js";

export const VEO_ASPECTS = ["16:9", "9:16"] as const;
export type VeoAspect = (typeof VEO_ASPECTS)[number];

/** Spec §7.6.3.2, and it matches the reference site's leg-1 / leg-2. */
export const DEFAULT_VIDEO_LEG_CAP = 2;

/**
 * AN OPT-IN IS A RAISE, NOT A BLANK CHEQUE — and this is the one number in this
 * module that no caller supplies, which is why the spending seam clamps to it
 * as well as to the plan's own `cap`. See `runVideoLegs`.
 */
export const MAX_VIDEO_LEG_CAP = 8;

export interface VideoLeg {
  /** 1-based → leg-1.mp4, matching the reference site. Counts SURVIVORS, not manifest position. */
  readonly index: number;
  readonly still: string;
  readonly section: string;
  readonly aspect: VeoAspect;
  readonly out: string;
  readonly poster: string;
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

export interface ResolvedLegCap {
  readonly cap: number;
  readonly capSource: "default" | "run-opt-in";
}

/**
 * THE ONLY PLACE A CAP ABOVE THE DEFAULT CAN COME FROM.
 *
 * Anything that is not an integer in [1, MAX_VIDEO_LEG_CAP] falls back to the
 * DEFAULT — never to the ceiling, and never with `capSource: "run-opt-in"`. A
 * junk value recorded as an opt-in makes the run record claim a deliberate raise
 * that nobody made, which is worse than the wrong number: it is a wrong number
 * with a false explanation attached.
 */
export function resolveLegCap(env: NodeJS.ProcessEnv): ResolvedLegCap {
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

/**
 * SEAM 1. Reads the on-disk manifest and clamps to the cap.
 *
 * A section that is rejected — bad aspect, no still — does NOT consume a leg
 * number and is not charged against the cap: `leg-1.mp4` is the first leg that
 * exists, because §7.6.4's consumption pattern hard-codes leg-1 first and a
 * `leg-2.mp4` with no sibling is a broken page.
 */
export function planVideoLegs(
  manifestJson: unknown,
  workspace: string,
  cap: ResolvedLegCap,
): VideoLegPlan {
  const sections =
    typeof manifestJson === "object" &&
    manifestJson !== null &&
    Array.isArray((manifestJson as { sections?: unknown }).sections)
      ? (manifestJson as { sections: unknown[] }).sections
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
      rejected.push({ section: name, why: "no `path` to a still — Veo 3.1 is driven from a first frame" });
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
    if (legs.length >= cap.cap) {
      droppedByCap += 1;
      continue;
    }
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
 * SEAM 2 — THE SEAM WHERE MONEY IS SPENT, AND THEREFORE THE SECOND PLACE THE CAP
 * LIVES. `plan.legs` is already clamped; this clamp is not redundancy for its own
 * sake. A future caller that builds a plan by hand, or a planner regression,
 * would otherwise turn the cap into a comment.
 *
 * TWO CLAMPS, NOT ONE, AND THEY CATCH DIFFERENT CALLERS.
 *   · `plan.cap` catches a plan that is inconsistent with itself — five legs
 *     carrying `cap: 2`, which is the planner-regression shape.
 *   · `MAX_VIDEO_LEG_CAP` catches a plan that is perfectly consistent and simply
 *     wrong — twelve legs carrying `cap: 12`, which is what a caller who skipped
 *     `resolveLegCap` produces. `slice(0, plan.cap)` alone waves that through
 *     twelve metered calls, from the very seam whose stated purpose is "a future
 *     caller that builds a plan by hand". The ceiling is the only bound here that
 *     no caller supplies, so it is the only one a caller cannot raise by accident.
 * Raising the ceiling is a source edit in this file, visible in a diff.
 *
 * SEQUENTIAL, NOT PARALLEL: each call is minutes long and metered, and two in
 * flight double the blast radius of a wrong prompt before anyone can look.
 * `video-legs.test.ts` observes that with an invoker that actually suspends —
 * an invoker that never yields makes `Promise.all` look sequential.
 */
export async function runVideoLegs(plan: VideoLegPlan, invoke: LegInvoker): Promise<LegRunSummary> {
  const legs = plan.legs.slice(0, Math.min(plan.cap, MAX_VIDEO_LEG_CAP));
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
  /** Seconds DELIVERED. A floor on what was billed, never a bill — see `renderVideoSpend`. */
  readonly meteredSeconds: number;
  readonly timeoutSeconds: number;
  readonly rejected: readonly RejectedSection[];
  readonly failures: readonly string[];
  /** ALWAYS null. See the comment below. */
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
 *
 * `meteredSeconds` IS A FLOOR, AND THE FIELD NAME DOES NOT SAY SO, SO THIS DOES.
 * It counts `produced × durationSeconds`: seconds of video that reached disk. A
 * leg that failed at the script's exit 4 — a truncated download — was generated
 * and billed and lands here as zero. `LegInvoker` returns `{ ok, detail }` and
 * carries no spend signal, so any larger number would be a guess dressed as a
 * measurement. The honest mitigation is that `legsAttempted` sits beside
 * `legsProduced` in the record: a reader who sees 2 attempted and 1 produced
 * knows the delivered figure is a lower bound. Do not widen `LegInvoker` with an
 * optional `spent` flag unless the caller that would set it is written in the
 * same change — an option nothing passes is a field that reads as measured and
 * is not.
 */
export function renderVideoSpend(input: {
  capability: VideoCapability;
  plan: VideoLegPlan;
  summary: LegRunSummary;
  model: string;
  resolution: string;
  durationSeconds: number;
  timeoutSeconds: number;
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
