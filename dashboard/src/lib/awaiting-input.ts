import type { RunDetail } from "@/lib/api-types";
import { planParkedFrom } from "@/lib/plan-dialogue";

/**
 * Why a run the generic "Waiting on input" notice describes is parked, read
 * off the wire.
 *
 * WHY THIS EXISTS — 2026-08-25, run `run-2026-08-25T10-30-39-122Z-d728ab79`.
 * That run parked `awaiting_input` after ONE creative-author call whose output
 * the compiler rejected (`MOTION_FALLBACK_INVALID` at `/motion/1/trigger`);
 * `#creativeContractPhase` (`server/src/orchestrator.ts`), in the one-call
 * form it had that morning, wrote `status: "awaiting_input"` together with
 * `failureReason: "creative contract invalid: creative author output did not
 * compile"` — the detail being the author's `!compiled.ok` branch in
 * `creative-contract-author.ts`. The plan dialogue was already settled
 * (`plan.awaiting=false`, `closed.reason="answered"`), so nothing had asked a
 * question — and the dashboard still showed the plan-question script "Type your
 * answer in the Chat panel, then press Resume". The owner typed "what is your
 * question?" into Chat, which stayed "queued — not read yet", because a parked
 * run has no live session and `Orchestrator.resume`'s generic tail merely
 * requeues (`status: "queued"`, `resumeCount + 1`, `pump()`); the re-authoring
 * on the next `#start` reads `authorInputFor(ticket, manifest)` and no chat
 * message at all. The notice was scripting an answer to a question that did
 * not exist. This function is what lets it stop.
 *
 * THE PRODUCER HAS SINCE CHANGED SHAPE, AND THIS FUNCTION DOES NOT CARE —
 * 2026-08-25, later the same day. `#creativeContractPhase` is now a
 * three-attempt repair loop whose park sentence reads `creative contract
 * ${status} on author attempt N of 3 (attempt not consumed): ${detail}` or
 * `creative contract invalid after N author attempts; last findings: …`; the
 * one-call sentence quoted above is historic — what the run recorded and what
 * `STALE_PLAN_DETAIL` carries. The discriminator here is `failureReason !==
 * null`, never a prefix and never the bytes, so the `check` kind survives any
 * rewording of the cause. Line numbers into `orchestrator.ts` are deliberately
 * not cited in this file: it was under concurrent edit, and every number cited
 * from it that day was stale by the next read.
 *
 * THE THREE KINDS, AND WHAT RESUME DOES FOR EACH.
 *   `question`     the plan dialogue is open; the chat IS the channel and the
 *                  answer must go in BEFORE Resume (`store.pendingMessages` →
 *                  `ownerMessageBlock` is folded in when `resume` composes the
 *                  next segment). "Type your answer, then press Resume."
 *   `check`        a cause was recorded on the row and nothing is being asked;
 *                  Resume requeues and the stopped step runs again. There is
 *                  nothing to type.
 *   `unexplained`  no cause on the wire. Resume does the same as for `check`;
 *                  the notice just has no cause to show.
 *
 * THE ORDER IS LOAD-BEARING. `planParkedFrom` is evaluated FIRST, before
 * `failureReason` is looked at, because a plan park can carry a STALE reason: a
 * run parked for a mockup choice carries `DESIGN LANE FAILED (too-few-images)`
 * while it is still live and still resumable (`lib/api-types.ts`, the
 * `failureReason` docblock), and a plan park that inherits such a string must
 * still read "answer, then Resume" — reading the reason first would tell the
 * owner there is nothing to type on a screen that is waiting for his answer.
 * Swap the first two predicates and `awaiting-input.unit.spec.ts` case 3b goes
 * red, which is the mutation its ledger records.
 *
 * TOTAL OVER THE STATES THAT REACH THE GENERIC NOTICE, AND NOTHING ELSE. This
 * does NOT decide the design-park or answerable-plan exclusion:
 * `runs/[runId]/page.tsx` keeps `lockPhase !== "pending" && !planAnswerable`
 * on the mount, and the mutations M7/M14 in `plan-dialogue.browser.spec.ts`
 * were measured against that line. Moving the exclusion in here would change
 * the equivalence class those were measured against, so it is left where it is.
 *
 * WHY THE THIRD KIND IS NAMED BY THE ABSENCE OF EVIDENCE RATHER THAN "crash".
 * `recoveryClass` is not on the wire: `server/src/api-types.ts` has no such
 * field, and `reconcileOnBoot`'s stop branch (`orchestrator.ts`) writes it to
 * the row only, alongside `status: "awaiting_input"` and `queuePosition:
 * null`, WITHOUT touching `failureReason`. So a run whose builder died with the dashboard arrives here
 * as "awaiting_input with no cause recorded" and cannot be told apart from any
 * other reasonless park. Naming it "crash" would be the notice claiming to know
 * something the body does not say.
 *
 * `failureReason` IS "THE LAST WRITE, NOT THE FIRST OR THE WORST" (one column,
 * five writers — `lib/api-types.ts`), which is why the `check` kind's label on
 * screen must say "Last recorded cause" and never "why it stopped".
 *
 * THE COMPARISON IS `!== null`, the house form the Failed notice uses
 * (`components/run/notices.tsx`): `RunDetail.failureReason` is declared
 * `string | null` and `server/src/http.ts` serialises `failureReason:
 * row.failureReason` on every detail body, so the key is present on every run
 * the dashboard can fetch today. The key-absence flattening `lib/api-types.ts`
 * records is for `machineChecks`, `designLock` and `adversary`, not this field.
 */
export type AwaitingInputKind = "question" | "check" | "unexplained";

export function awaitingInputKind(
  run: Pick<RunDetail, "phase" | "status" | "plan" | "failureReason">,
): AwaitingInputKind {
  // 1st: the plan dialogue is open — the chat is the channel, whatever the
  // row's last recorded cause says.
  if (planParkedFrom(run)) return "question";
  // 2nd: a cause was recorded and nothing is being asked.
  if (run.failureReason !== null) return "check";
  // 3rd: no cause on the wire (`reconcileOnBoot`'s park writes none).
  return "unexplained";
}
