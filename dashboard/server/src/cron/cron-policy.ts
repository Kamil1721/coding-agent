/**
 * cron-policy.ts — should this tick submit anything, and if not, WHY NOT.
 *
 * PURE ON PURPOSE. Every rule here is a decision about spending the owner's
 * quota while they are asleep, and a decision that can only be observed by
 * spending is a decision nobody checks. `decideTick` takes data and returns a
 * verdict; `cron-tick.ts` does the IO.
 *
 * OVERLAP IS A REFUSAL, NOT A QUEUE, and that is the one rule here that is a
 * judgement rather than a mechanism. Two POSTs while a run is active are
 * perfectly safe at the API level — `pump()` starts one and positions the rest,
 * and workspaces are per-run. They are not WANTED: an unattended scheduler that
 * enqueues on every tick accumulates work nobody asked for, and spends one
 * shared rate-limit window on all of it.
 *
 * ORDER IS LOAD-BEARING. Overlap is checked before the ceiling, so a night spent
 * building does not burn ceiling slots on refusals and then report "the ceiling
 * is spent" about a window in which nothing ran.
 *
 * THE EMPTY QUEUE IS CHECKED BEFORE THE CEILING, which is a deliberate deviation
 * from the plan's table — see the test of the same name. `refuse` exits non-zero;
 * a ceiling spent once would otherwise make every later tick in the window exit
 * non-zero even on nights with nothing to submit.
 */

import type { ApiRunStatus, RunSummary } from "../api-types.js";

/**
 * The wire's non-terminal statuses — the mirror of `isTerminal` in `db.ts`, over
 * the wire rather than over a row.
 *
 * A STATUS ADDED TO `ApiRunStatus` AND FORGOTTEN HERE WOULD BE TREATED AS
 * TERMINAL, and cron would submit over a live run. The test pins the complement
 * (`passed` / `failed` / `cancelled`) rather than this list, so adding a status
 * to the contract breaks the test rather than silently widening what cron will
 * build over.
 */
export const IN_FLIGHT: readonly ApiRunStatus[] = ["queued", "running", "awaiting_input", "rate_limited"];

export type TickPlan =
  | { readonly kind: "submit"; readonly ticketFile: string; readonly reason: string }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "refuse"; readonly reason: string };

export interface DecideInput {
  readonly now: string;
  /** Everything `GET /api/runs` returned. That route is unpaginated, so this is every run. */
  readonly runs: readonly RunSummary[];
  readonly intentsInWindow: number;
  /** Ticket file paths, in the order they would be claimed. */
  readonly queue: readonly string[];
  readonly maxRunsPerWindow: number;
  readonly windowHours: number;
}

export function decideTick(input: DecideInput): TickPlan {
  // 1. A RATE-LIMITED RUN FIRST, because its reason is the most actionable one:
  // submitting into an exhausted 5-hour window gets the new run throttled too,
  // and the existing run is resumable and is the better use of the window.
  const limited = input.runs.find((row) => row.status === "rate_limited");
  if (limited !== undefined) {
    return {
      kind: "skip",
      reason:
        `${limited.runId} is rate_limited: the provider's shared 5-hour window is exhausted, and a new ` +
        `run would be throttled too. That run resumes when the window drains.`,
    };
  }

  // 2. ANY OTHER NON-TERMINAL RUN. A refusal, not an enqueue.
  const live = input.runs.find((row) => IN_FLIGHT.includes(row.status));
  if (live !== undefined) {
    return {
      kind: "skip",
      reason:
        `${live.runId} is ${live.status}: cron does not submit over a run that has not finished. ` +
        `Enqueueing behind it would be safe and unwanted — one shared rate-limit window, two builds.`,
    };
  }

  // 3. NOTHING QUEUED IS THE ONE LEGITIMATE NO-OP, and it is a RECORDED one.
  if (input.queue.length === 0) {
    return { kind: "skip", reason: "no ticket in the queue: nothing was supposed to happen this tick" };
  }

  // 4. THE CEILING. A ceiling that logs instead of refusing is a comment.
  if (input.intentsInWindow >= input.maxRunsPerWindow) {
    return {
      kind: "refuse",
      reason:
        `the ceiling is spent: ${String(input.intentsInWindow)} submission intent(s) in the last ` +
        `${String(input.windowHours)} h, and the limit is ${String(input.maxRunsPerWindow)} per ` +
        `${String(input.windowHours)} h. ${String(input.queue.length)} ticket(s) stay queued.`,
    };
  }

  const ticketFile = input.queue[0];
  if (ticketFile === undefined) {
    // Unreachable given the length check above; `noUncheckedIndexedAccess` wants
    // it said out loud rather than asserted away.
    return { kind: "skip", reason: "no ticket in the queue: nothing was supposed to happen this tick" };
  }
  return {
    kind: "submit",
    ticketFile,
    reason:
      `one ticket, ${ticketFile}: no run is in flight and ${String(input.intentsInWindow)} of ` +
      `${String(input.maxRunsPerWindow)} intents are spent in the last ${String(input.windowHours)} h`,
  };
}
