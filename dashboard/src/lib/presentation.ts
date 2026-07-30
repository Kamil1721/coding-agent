import type {
  CriterionResult,
  CriterionTier,
  RunPhase,
  RunStatus,
} from "./api-types";

export type Tone = "pass" | "fail" | "warn" | "info" | "neutral" | "accent";

export interface StatusMeta {
  readonly label: string;
  readonly tone: Tone;
  /**
   * One line explaining the status. WRITTEN LOCATION-AGNOSTIC, DELIBERATELY.
   *
   * All three LIVE callers render it as the badge's `title` tooltip and nothing
   * else — the run HUD (`run-hud.tsx`), the home list (`app/page.tsx`) and the run
   * list (`app/runs/page.tsx`) — so a sentence pointing at a panel is true on at
   * most one of the three surfaces. (`components/run/header.tsx` also prints it as
   * a line of body text, but nothing imports that component; it is not a fourth
   * surface until something does.) `running` said "the trace below is live" until
   * 2026-07-30, by which point the trace had moved into a sheet tab and the
   * sentence pointed at nothing on any of them. Click paths belong in the
   * component that owns the click. Never marketing copy.
   */
  readonly meaning: string;
  /** True while the run can still change on its own. */
  readonly live: boolean;
}

const UNKNOWN_STATUS: StatusMeta = {
  label: "unknown",
  tone: "neutral",
  meaning:
    "The API reported a status this dashboard does not recognise. It is shown verbatim rather than guessed at.",
  live: false,
};

/**
 * Switch with a reachable `default`: the wire can carry a value outside the
 * frozen union even though the type says otherwise, and a neutral badge is a
 * better answer than a crash or a wrong colour.
 */
export function statusMeta(status: RunStatus): StatusMeta {
  switch (status) {
    case "queued":
      return {
        label: "queued",
        tone: "neutral",
        meaning: "Accepted and waiting for a worker.",
        live: true,
      };
    case "running":
      return {
        label: "running",
        tone: "accent",
        meaning: "The agent is working. New events are still arriving.",
        live: true,
      };
    case "awaiting_input":
      /*
       * TWO DIFFERENT PARKS SHARE THIS STATUS, and one sentence has to be true of
       * both — which is why it names no channel and no place on the screen.
       *
       *   · A DESIGN park: the mockup cards ARE the answer, and choosing one
       *     resumes the run in the same click (`resume(runId, chosenMockup)`,
       *     `server/src/http.ts`).
       *   · A plain park, including the one `reconcileOnBoot` sets for a run whose
       *     builder died with the server: the answer is typed into the chat.
       *
       * `AwaitingInputNotice` names the click path, because it renders only in the
       * second case (`runs/[runId]/page.tsx` suppresses it while a design lock is
       * pending). This string renders on three surfaces and cannot know which.
       *
       * SEQUENCING, WHICH THE OLD SENTENCE GOT BACKWARDS BY OMISSION — it said the
       * API "exposes no channel to answer", which stopped being true when the chat
       * shipped. A message sent to a PARKED run is not delivered: `pushLiveMessage`
       * returns false with no open segment, the row stays pending, and the
       * segment-boundary drain folds it into the next prompt (`orchestrator.ts`,
       * `store.pendingMessages`). So answer first, then resume. The other order
       * composes the next prompt without the answer in it.
       */
      return {
        label: "awaiting input",
        tone: "warn",
        meaning:
          "The run stopped for a decision from you. Answer it first, then resume — a message sent while it is parked is queued, not read, until the run restarts. Cancelling is the other move.",
        live: false,
      };
    case "rate_limited":
      return {
        label: "rate limited",
        tone: "warn",
        meaning:
          "The provider's rolling window is exhausted. This is an expected state on a subscription plan, not a failure — the run is preserved and can be resumed.",
        live: false,
      };
    case "passed":
      return {
        label: "passed",
        tone: "pass",
        meaning: "The held-out gate went green.",
        live: false,
      };
    case "failed":
      return {
        label: "failed",
        tone: "fail",
        meaning: "The run finished without passing the held-out gate.",
        live: false,
      };
    case "cancelled":
      return {
        label: "cancelled",
        tone: "neutral",
        meaning: "Stopped by you.",
        live: false,
      };
    default:
      return UNKNOWN_STATUS;
  }
}

export interface PhaseMeta {
  readonly label: string;
  readonly blurb: string;
}

export const PHASE_ORDER: readonly RunPhase[] = [
  "spec",
  "build",
  "gate",
  "judge",
  "done",
];

export function phaseMeta(phase: RunPhase): PhaseMeta {
  switch (phase) {
    case "spec":
      return {
        label: "Spec",
        blurb: "Acceptance criteria authored from the ticket, before any code.",
      };
    case "build":
      return { label: "Build", blurb: "The agent is implementing." };
    case "gate":
      return {
        label: "Gate",
        blurb: "Held-out suite running in a sealed container.",
      };
    case "judge":
      return { label: "Judge", blurb: "Per-criterion verdicts." };
    case "done":
      return { label: "Done", blurb: "Finished." };
    default:
      return { label: String(phase), blurb: "" };
  }
}

export function phaseIndex(phase: RunPhase): number {
  const index = PHASE_ORDER.indexOf(phase);
  return index === -1 ? 0 : index;
}

export interface TierMeta {
  readonly label: string;
  readonly gating: boolean;
  readonly note: string;
}

/**
 * QUALITY IS NEVER GATING. From `bakeoff/src/contracts.ts` and research doc 02
 * section 5.4: "QUALITY — a11y, responsive, error/empty states. REPORTED,
 * NEVER GATING. A passing quality score must never raise a grade." Rendering a
 * failed QUALITY criterion in the same red as a failed BLOCKING one would make
 * a passing run look failed, so it gets its own channel and says so in words.
 */
export function tierMeta(tier: CriterionTier): TierMeta {
  switch (tier) {
    case "BLOCKING":
      return {
        label: "Blocking",
        gating: true,
        note: "All must pass. Builds, boots, suite runs, no protected path touched.",
      };
    case "FUNCTIONAL":
      return {
        label: "Functional",
        gating: true,
        note: "One per user story. 100% required.",
      };
    case "QUALITY":
      return {
        label: "Quality",
        gating: false,
        note: "Reported, never gating. A failure here does not fail the run.",
      };
    default:
      return {
        label: String(tier),
        gating: false,
        note: "Unrecognised tier — treated as non-gating and reported as-is.",
      };
  }
}

export const TIER_ORDER: readonly CriterionTier[] = [
  "BLOCKING",
  "FUNCTIONAL",
  "QUALITY",
];

export function criterionTone(
  result: CriterionResult,
  gating: boolean,
): Tone {
  switch (result) {
    case "pass":
      return "pass";
    case "fail":
      return gating ? "fail" : "warn";
    case "pending":
      return "neutral";
    default:
      return "neutral";
  }
}

/*
 * `providerLabel` WAS HERE AND IS GONE (2026-07-30).
 *
 * Its only caller was the model picker's per-row vendor badge, and every row the
 * picker can now show is an Anthropic row — the owner removed the Kimi and
 * DeepSeek rows and Codex is not offered (see `server/src/models.ts`). A badge
 * reading "Anthropic" on every option is repetition, and a lookup table with two
 * of its four vendors deleted and no caller left is dead code. The panel says
 * "Claude" once, in words, instead.
 */

/**
 * Tone -> Tailwind classes. Kept in one table so that a state cannot acquire a
 * one-off colour: the failure screens have to look as deliberate as the happy
 * path, which only holds if they share the palette.
 */
export const TONE_BADGE: Readonly<Record<Tone, string>> = {
  pass: "border-pass/40 bg-pass-dim text-pass",
  fail: "border-fail/45 bg-fail-dim text-fail",
  warn: "border-warn/40 bg-warn-dim text-warn",
  info: "border-info/40 bg-info-dim text-info",
  accent: "border-accent/40 bg-accent-dim/50 text-accent",
  neutral: "border-line-strong bg-surface-raised text-ink-dim",
};

export const TONE_DOT: Readonly<Record<Tone, string>> = {
  pass: "bg-pass",
  fail: "bg-fail",
  warn: "bg-warn",
  info: "bg-info",
  accent: "bg-accent",
  neutral: "bg-ink-faint",
};

export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  pass: "text-pass",
  fail: "text-fail",
  warn: "text-warn",
  info: "text-info",
  accent: "text-accent",
  neutral: "text-ink-dim",
};
