/**
 * plan-record.ts — the plan park's DURABLE half, and the clock that bounds it.
 *
 * A DELIBERATE MIRROR OF `design-lock.ts`, because the failure it prevents is the
 * same one: a park's deadline lives in a `setTimeout`, a timer lives in a process
 * a restart destroys, and `awaiting_input` has no other exit. Without a record on
 * disk carrying the instant the park began, a dashboard restart during a plan
 * dialogue is an INFINITE park — the run waits for an answer to a question nobody
 * can now see, and the phase built to stop the dashboard guessing becomes the
 * reason a run never finishes at all.
 *
 * So the two halves are exactly design-lock's: `Orchestrator#reconcileOnBoot`
 * reads {@link readPlanRecord}, and either finishes an expired park or re-arms
 * the live timer for the REMAINDER of the original window. Neither half alone
 * bounds anything.
 *
 * ─── THIS FILE HOLDS NO SECOND STATE MODEL ───
 *
 * `PlanState` (plan-state.ts) is already the value: which questions are open,
 * what was answered, what was assumed. {@link PlanRecord} is an ENVELOPE around
 * it — three fields the state has no business knowing (is this run parked, when
 * did the park start, has the brief been amended yet) plus the state itself. A
 * second model of the same facts is how the disk and the dialogue come to
 * disagree about what is still open, which is the one question this whole phase
 * turns on.
 *
 * ─── AN UNREADABLE RECORD IS NEVER A THROW, AND IT IS NOT THE SAME AS AN
 *     ABSENT ONE ───
 *
 * {@link readPlanRecord} validates every field it reads and returns `null` for
 * anything it does not recognise. `readDesignLock` casts and hopes; here that
 * would be worse than sloppy, because the ONE caller that matters is the boot
 * loop. A throw there stops `reconcileOnBoot` before the rate-limit sweep, and a
 * silently-half-parsed record would leave a run parked on a question list it
 * cannot render.
 *
 * BUT `null` FOR BOTH CASES WAS ITS OWN INFINITE PARK, WHICH IS WHY
 * {@link readPlanRecordOutcome} EXISTS. `PlanDriver.reconcile` read that `null`
 * as "not plan-parked" and returned false; `reconcileOnBoot` then looked for
 * `design-lock.json`, found none, and moved on — leaving a run in
 * `awaiting_input` with no timer, no readable record and no exit, which is
 * precisely what the durable half of this file was written to prevent, reached
 * by corrupting the durable half. The two cases are now distinct and are
 * answered differently:
 *
 *   ABSENT      — this run is not plan-parked. Say so, because a design park and
 *                 a run whose builder died with the server BOTH look like this,
 *                 and resuming those on boot would restart work nobody asked to
 *                 restart.
 *   UNREADABLE  — a plan park whose record is gone. The run PROCEEDS, on the
 *                 design's own expiry behaviour, and what it had to assume is
 *                 recorded. {@link quarantinePlanRecord} keeps the bytes.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DroppedQuestion, PlanQuestion, PlanQuestionRefusal, PlanQuestionTier } from "./plan-question.js";
import { PLAN_QUESTION_TIERS } from "./plan-question.js";
import type {
  PlanAnswer,
  PlanAttribution,
  PlanClarification,
  PlanClosure,
  PlanClosureReason,
  PlanQuestionState,
  PlanQuestionStatus,
  PlanState,
} from "./plan-state.js";

export const PLAN_RECORD_FILE = "plan.json";

export const PLAN_TIMEOUT_ENV = "DASHBOARD_PLAN_TIMEOUT_MIN";

/**
 * Twenty minutes, and it is NOT the design lock's thirty.
 *
 * TWO PARKS WITH ONE KNOB IS A KNOB THAT IS WRONG FOR ONE OF THEM. The only
 * datum available is that run …c228e63b's 30-minute design lock expired
 * unanswered because the owner was asleep — which argues for nothing about
 * length, only that a longer window buys nothing from an absent owner. So the
 * number is set for a PRESENT owner, and two things push it below thirty: this
 * park happens seconds after he pressed submit, when he is most likely still at
 * the desk, where the design lock fires roughly an hour in when he most likely is
 * not; and this park blocks the ENTIRE run, where the design park has already
 * banked a design segment.
 *
 * IT BOUNDS THE WHOLE DIALOGUE, NOT EACH TURN. Every re-park after an owner turn
 * carries the ORIGINAL `parkedAt` forward, so answering does not buy more time —
 * see `Orchestrator#parkForPlan`.
 *
 * CHOSEN, NOT MEASURED. Calibrating it needs a re-run of the one-sentence ticket
 * with a human at the desk; until then this is a named constant so a measured
 * change is a one-line change.
 */
export const DEFAULT_PLAN_TIMEOUT_MIN = 20;

/**
 * Whether this run may park for a human at all.
 *
 * `designLockPolicy`'S ARGUMENT, VERBATIM: "a cron run that parks forever waiting
 * for a click is the exact failure unattended operation exists to avoid", and an
 * unrecognised value takes the direction that FINISHES.
 *
 * A `skip` RUN MAKES NO SEAT CALL AT ALL, which is stronger than not parking and
 * is the point. With nobody there to answer, no question can earn its place —
 * `questionEarnsItsPlace` measures worth by what an ANSWER would change — so the
 * call would spend the owner's quota to produce a list nothing can act on.
 */
export type PlanPolicy = "ask" | "skip";

export function planPolicy(interactive: boolean): PlanPolicy {
  return interactive ? "ask" : "skip";
}

export function planTimeoutMin(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseFloat((env[PLAN_TIMEOUT_ENV] ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PLAN_TIMEOUT_MIN;
}

/**
 * Computed from the PARK TIME, never from a live timer.
 *
 * `>=` IS LOAD-BEARING and it is `designLockExpired`'s reason: the live timer
 * fires at exactly `timeoutMin * 60_000` after the park, so the boot path must
 * already read that instant as expired. A park the timer would have resolved,
 * that the boot path then reads as "still waiting", is a park with no remaining
 * mechanism to end it.
 *
 * AN UNPARSEABLE INSTANT IS EXPIRED, like `designLockExpired`: a record whose
 * clock cannot be read is a park with no bound, and the safe direction is the one
 * that proceeds.
 */
export function planExpired(parkedAt: string, now: string, timeoutMin: number): boolean {
  const parked = Date.parse(parkedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(parked) || !Number.isFinite(at)) return true;
  return at - parked >= timeoutMin * 60_000;
}

/**
 * How long is left of the ORIGINAL window, floored at zero.
 *
 * THE FLOOR IS `#parkForDesignLock`'S (orchestrator.ts) AND `planRateLimitResume`'S:
 * a clock that went backwards, or a record older than the window, must arm a timer
 * that fires immediately rather than a negative delay Node silently turns into
 * `1 ms` — or, worse, a huge one.
 *
 * A FUNCTION RATHER THAN AN EXPRESSION IN THE PARK so the "a re-park does not
 * extend the deadline" property can be checked against a clock the test owns.
 */
export function planRemainingMs(parkedAt: string, now: number, timeoutMin: number): number {
  const parked = Date.parse(parkedAt);
  if (!Number.isFinite(parked)) return 0;
  return Math.max(0, timeoutMin * 60_000 - Math.max(0, now - parked));
}

/**
 * `plan.json`.
 *
 * `parkedAt` IS WRITTEN ONCE AND CARRIED FORWARD BY EVERY RE-PARK. It is the
 * instant the dialogue began, not the instant of the last turn — the difference
 * is whether the bound is real or only on paper, because a dialogue re-parks
 * after every owner turn.
 *
 * `folded` IS THE IDEMPOTENCE FLAG AND IT GUARDS TWO DIFFERENT THINGS. It stops a
 * second `#execute` entry re-amending a brief that already carries the exchange
 * (which would mint a third ticket id and orphan the frozen suite), and it is
 * what tells `reconcileOnBoot` that a run holding BOTH a settled `plan.json` and
 * an awaiting `design-lock.json` is parked for a MOCKUP, not for an answer.
 */
export interface PlanRecord {
  /** True only while the run is waiting for the owner. */
  readonly awaiting: boolean;
  /** The instant the dialogue first parked. Never rewritten. */
  readonly parkedAt: string;
  /** True once the exchange has been folded into the brief and the ticket re-derived. */
  readonly folded: boolean;
  readonly state: PlanState;
  /**
   * The highest owner-message `seq` that was ALREADY PENDING when the questions
   * first went out. Only a message above it can be an answer to them.
   *
   * WITHOUT IT THE DRAIN ATE THE WRONG MESSAGE. The plan phase is the first
   * phase, so an owner who submits a ticket and then types "also make it dark
   * mode" while the run starts has an undelivered message before any question
   * exists; `pendingMessages(runId)[0]` is that sentence, and it was handed to
   * the seat as his answer to PQ-1 and stamped delivered.
   *
   * ABSENT (`undefined`) MEANS THE QUESTIONS HAVE NOT GONE OUT YET, which is
   * what the opening park passes in; `PlanDriver.park` mints the value at that
   * moment and every re-park carries it forward, exactly like `parkedAt`. A re-park
   * that re-minted it would strand the message that arrived DURING the turn it
   * just took, which is the failure the drain loop exists to prevent.
   *
   * `null` MEANS A RECORD WRITTEN BEFORE THIS FIELD EXISTED — a park in flight
   * across the upgrade that added it. Those keep the old behaviour (every pending
   * message is a candidate) rather than acquiring a cut that never described
   * anything.
   */
  readonly askedAfterSeq?: number | null;
}

/** Where {@link quarantinePlanRecord} puts a record nothing can parse. */
export const PLAN_RECORD_UNREADABLE_FILE = "plan.json.unreadable";

/**
 * What is on disk, with "there is nothing" told apart from "there is something
 * and it cannot be read".
 *
 * THE DISTINCTION IS THE DIFFERENCE BETWEEN A RUN THAT FINISHES AND ONE THAT DOES
 * NOT. See the file header: both used to be `null`, and the boot loop read that
 * as "not a plan park" for both.
 */
export type PlanRecordRead =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "record"; readonly record: PlanRecord };

export function writePlanRecord(resultsDir: string, record: PlanRecord): void {
  writeFileSync(join(resultsDir, PLAN_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * The record, or `null` for "there is no record this file can use".
 *
 * IT COLLAPSES THE TWO NULLS ON PURPOSE and is kept because most callers do not
 * care which they got: `#planPhase` treats both as "no dialogue has happened
 * here", which is right for both. The ONE caller that must tell them apart is
 * `PlanDriver.reconcile`, and it uses {@link readPlanRecordOutcome}.
 *
 * EVERY FIELD IS CHECKED. See the file header for why a cast would be worse here
 * than in `readDesignLock`.
 */
export function readPlanRecord(resultsDir: string): PlanRecord | null {
  const outcome = readPlanRecordOutcome(resultsDir);
  return outcome.kind === "record" ? outcome.record : null;
}

/**
 * The same read, with the reason it failed.
 *
 * THREE WAYS TO BE UNREADABLE AND ONE RESOLUTION: the file will not open, the
 * bytes are not JSON, or the JSON is not a record this phase wrote. All three
 * mean the same thing to the boot loop — there was a plan park here and its state
 * is gone — and `detail` is what the owner's log gets to say which.
 */
export function readPlanRecordOutcome(resultsDir: string): PlanRecordRead {
  const path = join(resultsDir, PLAN_RECORD_FILE);
  if (!existsSync(path)) return { kind: "none" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A DIRECTORY IN ITS PLACE, OR NO PERMISSION. Rare, and it throws where every
    // other failure returns — so it is caught here rather than left to escape
    // `reconcileOnBoot` and stop the rate-limit sweep behind it.
    return { kind: "unreadable", detail: `it could not be opened: ${message(error)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unreadable", detail: "it is not JSON — a truncated or half-written file" };
  }
  const record = asPlanRecord(raw);
  return record === null
    ? { kind: "unreadable", detail: "it is JSON, but not a plan record this dashboard recognises" }
    : { kind: "record", record };
}

/**
 * Move a record nothing can parse aside, so the resolution can write a fresh one.
 *
 * THE BYTES ARE EVIDENCE. A record that cannot be parsed means either a crash
 * mid-write or a drift between the writer and the four hand-written unions below,
 * and both are worth reading afterwards; overwriting in place would resolve the
 * run and destroy the only copy of why it needed resolving.
 *
 * A RENAME THAT FAILS IS NOT AN ERROR HERE. The caller's job is to end the park;
 * losing the forensic copy must not stop that, so this returns `null` and says
 * nothing.
 */
export function quarantinePlanRecord(resultsDir: string): string | null {
  const from = join(resultsDir, PLAN_RECORD_FILE);
  const to = join(resultsDir, PLAN_RECORD_UNREADABLE_FILE);
  try {
    renameSync(from, to);
    return to;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asPlanRecord(raw: unknown): PlanRecord | null {
  const record = asObject(raw);
  if (record === null) return null;
  const awaiting = record["awaiting"];
  const parkedAt = record["parkedAt"];
  const folded = record["folded"];
  const state = asPlanState(record["state"]);
  if (typeof awaiting !== "boolean" || typeof parkedAt !== "string" || typeof folded !== "boolean") return null;
  if (state === null) return null;
  // A RECORD FROM BEFORE THIS FIELD EXISTED READS BACK AS `null`, NOT ABSENT, and
  // the difference is load-bearing — see {@link PlanRecord.askedAfterSeq}.
  const rawAsked = record["askedAfterSeq"];
  if (rawAsked !== null && rawAsked !== undefined && typeof rawAsked !== "number") return null;
  const askedAfterSeq = typeof rawAsked === "number" ? rawAsked : null;
  return { awaiting, parkedAt, folded, state, askedAfterSeq };
}

/**
 * The state of a dialogue that never happened, with the reason on it.
 *
 * TWO RUNS REACH THIS AND THEY MUST STAY DISTINGUISHABLE: a run nobody was
 * watching (`planPolicy` said `skip`), and a run whose seat call could not be
 * made or could not be read. Both asked nothing; only the second is a defect, and
 * `detail` is where the difference is recorded. The closure reason is
 * `nothing to ask` for both because that is what happened — no question ever
 * reached the owner — and a fifth reason would be a second name for one fact.
 */
export function unaskedPlanState(at: string, detail: string): PlanState {
  return {
    plan: [],
    questions: [],
    clarifications: [],
    dropped: [],
    proposed: 0,
    turnsUsed: 0,
    closed: { reason: "nothing to ask", at, detail },
  };
}

/* -------------------------------------------------------------------------
 * Narrowing — no `any`, no cast that could be wrong
 * ---------------------------------------------------------------------- */

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

function asPlanState(value: unknown): PlanState | null {
  const record = asObject(value);
  if (record === null) return null;

  const plan = asStringArray(record["plan"]);
  const proposed = record["proposed"];
  const turnsUsed = record["turnsUsed"];
  if (plan === null || typeof proposed !== "number" || typeof turnsUsed !== "number") return null;

  const questions = mapOrNull(record["questions"], asQuestionState);
  const clarifications = mapOrNull(record["clarifications"], asClarification);
  const dropped = mapOrNull(record["dropped"], asDropped);
  if (questions === null || clarifications === null || dropped === null) return null;

  const rawClosed = record["closed"];
  let closed: PlanClosure | null = null;
  if (rawClosed !== null && rawClosed !== undefined) {
    closed = asClosure(rawClosed);
    if (closed === null) return null;
  }

  return { plan, questions, clarifications, dropped, proposed, turnsUsed, closed };
}

function mapOrNull<T>(value: unknown, read: (entry: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = read(entry);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/*
 * ─── FOUR HAND-WRITTEN COPIES OF UNIONS DECLARED ELSEWHERE, EACH WITH A
 *     COMPILE-TIME COMPLETENESS GUARD ───
 *
 * `PLAN_QUESTION_TIERS` is IMPORTED because plan-question.ts exports it as a
 * value. The four below have no value export to import, so they are retyped —
 * which db.ts:368 already names as a declaration site that can drift, in almost
 * these words ("THE SEAT VOCABULARY IS IMPORTED, NOT RETYPED").
 *
 * WHAT DRIFT WOULD COST HERE, AND WHY IT IS WORSE THAN A MISSING LABEL. A member
 * added to `PlanClosureReason` and not to `CLOSURE_REASONS` makes `asClosure`
 * return null for a record that is perfectly valid; `readPlanRecord` then returns
 * null; `PlanDriver.reconcile` reads that as "not plan-parked" and returns false;
 * `reconcileOnBoot`'s design-lock loop `continue`s. The run sits in
 * `awaiting_input` with no timer and no exit — the infinite park the durable half
 * of this file exists to prevent, reached by adding a word to an unrelated union.
 * The live timer still rescues a park inside one process, so ONLY A RESTART
 * DURING A PARK wedges, which is exactly the case no other mechanism covers.
 *
 * THE GUARD IS THE NEGATIVE CONTROL AND IT NEEDS NO TEST: `Exclude<Union, member>`
 * is `never` only while the list is complete, so adding a member to any of these
 * unions without adding it here fails `tsc` on the line below it. A runtime test
 * could not do better — it would have to know the new member's name to look for
 * it.
 */
const QUESTION_STATUSES = ["open", "answered", "declined", "expired"] as const;
const missingStatus: Exclude<PlanQuestionStatus, (typeof QUESTION_STATUSES)[number]> extends never
  ? true
  : never = true;
void missingStatus;

const ATTRIBUTIONS = ["structural", "addressed", "inferred"] as const;
const missingAttribution: Exclude<PlanAttribution, (typeof ATTRIBUTIONS)[number]> extends never
  ? true
  : never = true;
void missingAttribution;

const CLOSURE_REASONS = ["answered", "declined", "turn cap", "window expired", "nothing to ask"] as const;
const missingClosureReason: Exclude<PlanClosureReason, (typeof CLOSURE_REASONS)[number]> extends never
  ? true
  : never = true;
void missingClosureReason;

const REFUSALS = [
  "no-text",
  "no-criterion-pair",
  "criteria-do-not-differ",
  "no-default",
  "not-one-sentence",
  "too-long",
  "answered-by-the-brief",
  "criterion-needs-an-attachment",
  "duplicate",
  "over-cap",
] as const;
const missingRefusal: Exclude<PlanQuestionRefusal, (typeof REFUSALS)[number]> extends never ? true : never = true;
void missingRefusal;

function member<T extends string>(allowed: readonly T[], value: unknown): T | null {
  if (typeof value !== "string") return null;
  return allowed.find((entry) => entry === value) ?? null;
}

function asQuestion(value: unknown): PlanQuestion | null {
  const record = asObject(value);
  if (record === null) return null;
  const id = record["id"];
  const text = record["text"];
  const ifUnanswered = record["ifUnanswered"];
  const criterionIfDefault = record["criterionIfDefault"];
  const criterionIfAnswered = record["criterionIfAnswered"];
  const tier: PlanQuestionTier | null = member(PLAN_QUESTION_TIERS, record["tier"]);
  if (
    typeof id !== "string" ||
    typeof text !== "string" ||
    typeof ifUnanswered !== "string" ||
    typeof criterionIfDefault !== "string" ||
    typeof criterionIfAnswered !== "string" ||
    tier === null
  ) {
    return null;
  }
  return { id, text, ifUnanswered, criterionIfDefault, criterionIfAnswered, tier };
}

function asAnswer(value: unknown): PlanAnswer | null {
  const record = asObject(value);
  if (record === null) return null;
  const text = record["text"];
  const quoted = record["quoted"];
  const at = record["at"];
  const attribution = member(ATTRIBUTIONS, record["attribution"]);
  const paraphrased = record["paraphrased"];
  if (
    typeof text !== "string" ||
    typeof quoted !== "string" ||
    typeof at !== "string" ||
    attribution === null ||
    typeof paraphrased !== "boolean"
  ) {
    return null;
  }
  return { text, quoted, at, attribution, paraphrased };
}

function asQuestionState(value: unknown): PlanQuestionState | null {
  const record = asObject(value);
  if (record === null) return null;
  const question = asQuestion(record["question"]);
  const status = member(QUESTION_STATUSES, record["status"]);
  if (question === null || status === null) return null;

  const rawAnswer = record["answer"];
  let answer: PlanAnswer | null = null;
  if (rawAnswer !== null && rawAnswer !== undefined) {
    answer = asAnswer(rawAnswer);
    if (answer === null) return null;
  }
  const rawAssumed = record["assumed"];
  if (rawAssumed !== null && rawAssumed !== undefined && typeof rawAssumed !== "string") return null;
  const assumed = typeof rawAssumed === "string" ? rawAssumed : null;

  return { question, status, answer, assumed };
}

function asClarification(value: unknown): PlanClarification | null {
  const record = asObject(value);
  if (record === null) return null;
  const at = record["at"];
  const asked = record["asked"];
  const reply = record["reply"];
  const about = asStringArray(record["about"]);
  if (typeof at !== "string" || typeof asked !== "string" || typeof reply !== "string" || about === null) {
    return null;
  }
  return { at, about, asked, reply };
}

function asDropped(value: unknown): DroppedQuestion | null {
  const record = asObject(value);
  if (record === null) return null;
  const text = record["text"];
  const detail = record["detail"];
  const refusal = member(REFUSALS, record["refusal"]);
  if (typeof text !== "string" || typeof detail !== "string" || refusal === null) return null;
  return { text, refusal, detail };
}

function asClosure(value: unknown): PlanClosure | null {
  const record = asObject(value);
  if (record === null) return null;
  const at = record["at"];
  const detail = record["detail"];
  const reason = member(CLOSURE_REASONS, record["reason"]);
  if (typeof at !== "string" || typeof detail !== "string" || reason === null) return null;
  return { reason, at, detail };
}
