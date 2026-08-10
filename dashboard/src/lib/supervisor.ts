/**
 * THE THREE-STATE READ: running · idle · stuck — plus the two answers for "I
 * could not read it": `unreachable` (nothing usable arrived) and `malformed` (a
 * 200 arrived on time and is not a supervisor reading).
 *
 * WHY THIS IS A MODULE AND NOT A COMPONENT BRANCH. The owner is away eight
 * hours. When he looks he has to tell working from stuck in under five seconds,
 * and on 2026-08-09 the screen said "Writing the tests — WORKING" for 87 minutes
 * while the same manifest field was rejected three times. That sentence was not
 * a rendering bug: nothing in the app had ever been asked the question "is this
 * making progress", so nothing could answer it wrongly either. Putting the
 * answer in a pure function is what makes it testable at all, and every arm
 * below is exercised by `tests/supervisor-strip.unit.spec.ts` in BOTH
 * directions — the state it must produce and a neighbouring input it must not.
 *
 * THE ONE RULE EVERYTHING ELSE FOLLOWS FROM: never render a confident
 * `running` that the data does not support. Four inputs make `running`
 * unprovable and every one of them resolves somewhere else —
 *
 *   the endpoint did not answer            -> unreachable
 *   the reading is older than the poll      -> unreachable (stale, NOT live)
 *   a ticket is claimed with no run          -> stuck
 *   a run is live with no progress clock     -> stuck
 *
 * The inverse error is the one that cost real time: a preview card told the
 * owner his backend was down while it was up. So `unreachable` says which read
 * failed and when the last good one was, rather than painting the whole strip
 * as a fault.
 */

import type {
  SupervisorAttemptView,
  SupervisorRepair,
  SupervisorRepairCycle,
  SupervisorState,
  SupervisorTicketCensus,
  SupervisorTicketRow,
} from "./api-types";

/* ------------------------------------------------------------------ */
/* THE ATTEMPT COMPARATOR — DESIGN §3.4, client side                   */
/* ------------------------------------------------------------------ */

/**
 * What the authoring loop is doing to its own rejection set.
 *
 * `shrinking`   each attempt is rejected on a STRICT SUBSET of the last one's
 *               paths. The feedback channel is working; spending another
 *               attempt is legitimate.
 * `repeating`   the identical set came back. The channel is not working.
 * `diverging`   a path the previous attempt was not rejected on has appeared.
 *               Not a shrink, so not convergence.
 * `oscillating` a path that a later attempt had fixed came back. a913c871
 *               exactly: `id` -> `kind` -> `id`. THIS IS THE ARM NO COUNTER CAN
 *               SEE — three attempts, budget never exceeded, run dead.
 * `unknown`     fewer than two attempts, or an attempt with no recorded
 *               problems. Deliberately NOT folded into `shrinking`: an empty
 *               problem list is missing evidence, and missing evidence must
 *               never read as convergence.
 *
 * The severity order is oscillating > repeating > diverging > shrinking, and
 * the label reported is the worst pair seen across the whole trail rather than
 * the last pair, because a trail that oscillated and then happened to shrink
 * has still proved its channel non-convergent.
 */
export type AttemptProgress =
  | "shrinking"
  | "repeating"
  | "diverging"
  | "oscillating"
  | "unknown";

export interface AttemptComparison {
  readonly progress: AttemptProgress;
  /**
   * The 1-based index of the FIRST attempt whose rejection set failed to
   * shrink — the attempt at which DESIGN §3.4 says stop spending. `null` while
   * the trail is still converging or still unreadable.
   *
   * For a913c871 this is 2, and the third attempt is the one that never should
   * have been spent.
   */
  readonly escalatesAtAttempt: number | null;
  /** Paths named in more than one attempt after having been absent from one. */
  readonly recurringPaths: readonly string[];
}

/**
 * `unknown` IS NOT IN THIS TABLE, AND THAT IS THE FIX FOR A REAL BUG.
 *
 * It was ranked 0, below `shrinking`, and the effect was that a trail whose
 * second attempt recorded NO findings — missing evidence — came back
 * `shrinking`, i.e. "the channel is working, spend another attempt". The
 * comparator was reading an absence as a success, which is this repository's
 * signature defect inside the very function written to catch it.
 *
 * `unknown` cannot be a rank because it is not a severity: it is a statement
 * that a pair could not be compared, and it has to beat `shrinking` (there is
 * no evidence of convergence) while losing to every arm that DID observe
 * something. That is not a total order, so it is a separate flag below.
 */
const SEVERITY: Readonly<Record<Exclude<AttemptProgress, "unknown">, number>> = {
  shrinking: 1,
  diverging: 2,
  repeating: 3,
  oscillating: 4,
};

function normalise(problems: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const problem of problems) {
    const trimmed = problem.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen].sort();
}

function isStrictSubset(
  inner: readonly string[],
  outer: readonly string[],
): boolean {
  if (inner.length >= outer.length) return false;
  const set = new Set(outer);
  return inner.every((path) => set.has(path));
}

export function attemptProgress(
  attempts: readonly SupervisorAttemptView[],
): AttemptComparison {
  const sets = attempts.map((attempt) => normalise(attempt.problems));

  if (sets.length < 2) {
    return { progress: "unknown", escalatesAtAttempt: null, recurringPaths: [] };
  }

  let worst: Exclude<AttemptProgress, "unknown"> | null = null;
  let sawUnreadablePair = false;
  let escalatesAt: number | null = null;
  const recurring = new Set<string>();

  for (let i = 1; i < sets.length; i += 1) {
    const previous = sets[i - 1] ?? [];
    const current = sets[i] ?? [];

    // A blank side is missing evidence, not progress. Say so and stop
    // claiming anything about this pair.
    if (previous.length === 0 || current.length === 0) {
      sawUnreadablePair = true;
      continue;
    }

    // Did anything come back that an EARLIER attempt had already stopped being
    // rejected on? That is the oscillation, and it is checked against the whole
    // prefix rather than just the previous set — `id -> kind -> id` has the
    // reappearance two steps apart.
    let oscillated = false;
    for (const path of current) {
      if (previous.includes(path)) continue;
      for (let j = 0; j < i - 1; j += 1) {
        if ((sets[j] ?? []).includes(path)) {
          oscillated = true;
          recurring.add(path);
          break;
        }
      }
    }

    let pair: Exclude<AttemptProgress, "unknown">;
    if (oscillated) {
      pair = "oscillating";
    } else if (
      current.length === previous.length &&
      current.every((path, index) => path === previous[index])
    ) {
      pair = "repeating";
    } else if (isStrictSubset(current, previous)) {
      pair = "shrinking";
    } else {
      pair = "diverging";
    }

    if (pair !== "shrinking" && escalatesAt === null) {
      // 1-based, and it names the attempt that PRODUCED the non-shrinking set.
      escalatesAt = i + 1;
    }
    if (worst === null || SEVERITY[pair] > SEVERITY[worst]) worst = pair;
  }

  /*
   * A trail that had an unreadable pair is `unknown` UNLESS something worse was
   * actually observed. "No evidence" outranks "evidence of convergence" and is
   * outranked by any evidence of failure to converge.
   */
  const progress: AttemptProgress =
    worst === null || (sawUnreadablePair && worst === "shrinking") ? "unknown" : worst;

  return {
    progress,
    escalatesAtAttempt: escalatesAt,
    recurringPaths: [...recurring].sort(),
  };
}

/* ------------------------------------------------------------------ */
/* THE CLASSIFIER                                                      */
/* ------------------------------------------------------------------ */

/**
 * FIVE ANSWERS, AND THE FIFTH IS NOT A FLAVOUR OF THE FOURTH.
 *
 * `running`, `idle` and `stuck` are the three the owner asked for. `unreachable`
 * is what the strip owes him when it cannot support any of them — no answer, a
 * failed answer, or an answer too old to be live. `malformed` is the case those
 * four could not express: THE ROUTE ANSWERED, ON TIME, AND THE BODY IS NOT A
 * SUPERVISOR READING.
 *
 * WHY IT IS ITS OWN WORD RATHER THAN `unreachable` WITH A LONGER SENTENCE. The
 * two ask for different actions. `unreachable` may fix itself — a restarting
 * server, a dropped poll — and the honest advice is to look again in a minute.
 * `malformed` never fixes itself by waiting: something that is not this
 * dashboard's supervisor route is answering that path, and until that changes
 * this strip will report nothing for the rest of the night. Folding it into
 * `unreachable` put the only actionable half of the message in a sentence that
 * the 30px row truncates.
 *
 * IT SHARES THE AMBER TONE WITH `unreachable`, DELIBERATELY. Amber means THIS
 * PAGE CANNOT SEE; red means the loop is wedged and the owner must act on the
 * RUN. A malformed body says nothing whatever about the run — the supervisor may
 * be working perfectly — so painting it red would be yesterday's preview card
 * again, telling the owner his backend is down when it is up. The colour
 * separates "cannot see" from "wedged"; the word separates the two ways of not
 * seeing.
 */
/**
 * `blocked` IS THE SIXTH, AND IT IS THE ONE THE OWNER CAME BACK TO AT 7AM AND
 * COULD NOT SEE (added 2026-08-10).
 *
 * THE MEASURED GAP. When the loop finishes the night's work, `ticket` is null and
 * `queueDepth` is 0. When every ticket dies at `blocked`, `ticket` is null and
 * `queueDepth` is 0 — `http.ts:1256` counts only rows in state `queued`. Both
 * rendered `IDLE / idle, queue empty`, byte for byte. Eight hours of the owner's
 * subscription window, and the readout was identical whether it worked or
 * everything died. That is not a missing feature, it is a CONFIDENT STATEMENT THE
 * PAGE HAS NO DATA FOR, the same class as the preview card that announced a
 * healthy backend was down.
 *
 * WHY IT IS A LIVENESS VALUE AND NOT A DIFFERENT HEADLINE UNDER `idle`.
 * `armSupervisorStrip` proves the strip is not blind by requiring N KNOWN INPUTS
 * TO PRODUCE N DIFFERENT ANSWERS, and the answers it compares are liveness
 * strings. A distinction that exists only in prose is a distinction the arm check
 * cannot measure — which would be this repository's signature defect committed
 * inside the fix for it. So the failure ending gets its own word, the arm check
 * counts six, and the collapse of `blocked` onto `idle` makes the arm say BLIND.
 *
 * IT IS RED, NOT AMBER, AND THAT IS THE ONE PLACE THIS TYPE'S COLOUR RULE READS
 * BACKWARDS AT FIRST GLANCE. Amber means THIS PAGE CANNOT SEE. Here the page sees
 * perfectly and what it sees is that the work failed: the owner has to act, on the
 * RUN, which is what red has meant since the first version. Painting a legible
 * failure amber would be the inverse invention — reporting a reading problem over
 * a real defect.
 *
 * WHAT IT DOES NOT CLAIM. `blocked` says the queue reached its end with failures
 * in it. It says NOTHING about why, and it cannot: the failure class lives on the
 * ticket row. The sentence carries the blocked ticket's own `next_action`, which
 * is the string that tells the owner what to run by hand.
 */
export type SupervisorLiveness =
  | "running"
  | "idle"
  | "stuck"
  | "blocked"
  | "unreachable"
  | "malformed";

/**
 * HOW LONG A LIVE RUN MAY BE SILENT BEFORE THE STRIP SAYS `stuck`.
 *
 * 40 minutes, and the number is measured rather than chosen for roundness.
 * a913c871's largest REAL gap between events was 25.2 min and its whole spec
 * phase was 84.6 min, while `DEFAULT_SILENCE_WARN_MIN = 90` never fired once.
 * So the threshold has to sit above the largest silence a healthy seat has
 * actually produced here and well below the warn that has never fired.
 *
 * THIS IS NOT THE a913c871 DETECTOR AND MUST NOT BE SOLD AS ONE. That run was
 * never quiet for 40 minutes — it was emitting attempt boundaries the whole
 * time. `attemptProgress` is what catches it. This threshold catches the other
 * shape: a seat that died with the socket open.
 */
export const STUCK_AFTER_MS = 40 * 60_000;

/**
 * HOW OLD A READING MAY BE BEFORE IT STOPS COUNTING AS LIVE.
 *
 * 90 s against a 5 s poll. A backgrounded tab, a suspended laptop or a dead
 * `setInterval` all produce a snapshot that keeps rendering and stops being
 * true, and nothing about it LOOKS wrong — which is the signature defect with a
 * timestamp on it. Generous enough that one dropped poll is not an alarm.
 */
export const STALE_AFTER_MS = 90_000;

export interface SupervisorReadingInput {
  /** The last successfully parsed body, or `null` if there has never been one. */
  readonly snapshot: SupervisorState | null;
  /*
   * THERE IS NO `attempts` INPUT ANY MORE, AND ITS REMOVAL IS THE FIX FOR A
   * CRASH PATH RATHER THAN A TIDY (2026-08-10).
   *
   * The trail is on the wire (`SupervisorState.attempts`, empty in this build and
   * named in `probe.unsourced`), so a second channel for it would be a second
   * source of truth. Worse, the only honest way to fill it from a component was
   * `data.body.attempts` — an UNVALIDATED field — and `attemptProgress` calls
   * `.map` on whatever it is handed, INSIDE this function, before the arm written
   * to catch a wrong-shaped body can answer. The classifier now reads the trail
   * off the body it has just validated.
   */
  /** Whatever the fetch threw, or `null`. A non-null error means THIS read failed. */
  readonly error: unknown;
  /**
   * `GET /api/supervisor/tickets`, RAW AND UNPARSED — and `unknown` is the whole
   * safety argument, not laziness about a type.
   *
   * The removed `attempts` input above is the precedent: the only honest way for a
   * component to fill it was `data.body.attempts`, an UNVALIDATED field, and
   * `attemptProgress` then called `.map` on it INSIDE this function, before the arm
   * written to catch a wrong-shaped body could answer. A pre-parsed
   * `SupervisorTicketCensus` handed in from `supervisor-strip.tsx` would rebuild
   * that path with `censusCounts`'s `for…of` as the throw site. So the body arrives
   * as it left the socket and {@link readCensus} is the only thing that reads it.
   *
   * `undefined` (SWR before the first response) and `null` are both "no census",
   * and here — unlike everywhere else in this file — they are NOT distinguished:
   * the distinction would be between two shapes of nothing arriving, and neither
   * says anything about the queue.
   */
  readonly censusBody: unknown;
  /**
   * Whatever the census fetch threw. TODAY'S EXPECTED VALUE IS A 404: the GET has
   * no producer (measured 2026-08-10 — `dashboard/server/src` serves only the
   * POST), so the reading must degrade to a named absence rather than to an error
   * banner about a route the owner never asked for.
   */
  readonly censusError: unknown;
  /**
   * WHEN THIS CLIENT RECEIVED THE BODY — `null` before the first one lands.
   *
   * IT IS THE CLIENT'S CLOCK AND NOT THE SERVER'S, AND THAT IS A LIMIT WORTH
   * WRITING DOWN. `ApiSupervisorState` has no `at`, so nothing on the wire says
   * when the server composed the answer; the only freshness this page can
   * measure is its own poll's. That catches the case that actually happens — a
   * suspended tab or a dead interval still painting a green bar — and it cannot
   * catch a server that answers instantly with a body it computed an hour ago.
   * If the route ever grows a stamp, age it against that instead.
   */
  readonly receivedAtMs: number | null;
  readonly nowMs: number;
}

export interface SupervisorReading {
  readonly liveness: SupervisorLiveness;
  /** Two or three words. The five-second read. */
  readonly headline: string;
  /** The sentence under it. NEVER blank — see the invariant test. */
  readonly because: string;
  readonly quietForMs: number | null;
  readonly progress: AttemptProgress;
  readonly escalatesAtAttempt: number | null;
  /**
   * Paths rejected, fixed, and rejected again — PUBLISHED HERE so the panel does
   * not run the comparator a second time to get them. Two call sites computing the
   * same comparison from two arguments is how the strip's highlighted rows and the
   * strip's headline come to disagree about which attempt broke.
   */
  readonly recurringPaths: readonly string[];
  /**
   * True when nothing on screen came from a supervisor reading that is CURRENT.
   *
   * IT USED TO SAY "a snapshot exists but is being shown as history", AND ARM 3b
   * MADE THAT FALSE (corrected 2026-08-10 in the same pass that wrote the arm).
   * Arms 2 and 3 do fit the old wording — a good body, aged or superseded by a
   * failed read. Arm 3b sets `stale: true` with `snapshot: null`, because a 200
   * whose body is not a `SupervisorState` is not a reading at all: there is no
   * history to show and nothing about the supervisor is being reported. Both cases
   * mean the same thing to the strip, which paints `data-stale` from this field —
   * do not trust what is on screen as live — so they share the flag, and the
   * declaration is widened to the truth rather than left describing two thirds of
   * its own arms.
   */
  readonly stale: boolean;
  /**
   * The body, ONLY when it is one this contract can be read from.
   *
   * `null` on arm 1 (nothing was ever read) and on arm 3b (the 200 was not a
   * `SupervisorState`). It is NOT null on arms 2 and 3, where a well-formed body is
   * deliberately kept and aged. A consumer may dereference this field's own
   * declared fields without checking them: see arm 3b for the 77 browser failures
   * that bought that guarantee.
   */
  readonly snapshot: SupervisorState | null;
  /**
   * THE TICKET CENSUS AS READ THIS POLL — ALWAYS PRESENT, NEVER NULL.
   *
   * The field is not nullable even when there is no census, and that is a
   * deliberate departure from `snapshot` above. A nullable field is one every
   * consumer must branch on and one some consumer will forget; `census.availability`
   * plus `census.note` is a legible state for all four answers, "nothing arrived"
   * included. Making it null when the route 404s would leave the panel rendering an
   * empty region for a missing census — the absence-as-nothing defect that this
   * whole census exists to remove.
   */
  readonly census: CensusReading;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.trim().slice(0, 200);
  }
  if (typeof error === "string" && error.trim() !== "") {
    return error.trim().slice(0, 200);
  }
  return "the request failed with no message";
}

/** The three words the server may send. Anything else is not this contract. */
const KNOWN_DESIRED: readonly string[] = ["running", "draining", "stopped"];

/** What a field IS, in words a sentence can carry. `absent` is not `null`. */
function typeName(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  return `a ${typeof value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * THE FIELD CHECKS, ONE PER SHAPE THE CONTRACT DECLARES.
 *
 * `T | null`, NEVER `T?` — `api-types.ts` makes that promise explicitly ("the
 * supervisor says there is no run" and "the field is missing" must not collapse
 * into one `undefined`), so `absent` is a failure wherever `null` is legal and
 * the message says which of the two it got.
 */
function checkString(wrong: string[], record: Record<string, unknown>, path: string, key = path): void {
  if (typeof record[key] !== "string") wrong.push(`${path} is ${typeName(record[key])}, not a string`);
}

function checkStringOrNull(
  wrong: string[],
  record: Record<string, unknown>,
  path: string,
  key = path,
): void {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    wrong.push(`${path} is ${typeName(value)}, not a string or null`);
  }
}

function checkNumber(wrong: string[], record: Record<string, unknown>, path: string, key = path): void {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    wrong.push(`${path} is ${typeof value === "number" ? "not a finite number" : `${typeName(value)}, not a number`}`);
  }
}

function checkNumberOrNull(
  wrong: string[],
  record: Record<string, unknown>,
  path: string,
  key = path,
): void {
  const value = record[key];
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    wrong.push(
      `${path} is ${typeof value === "number" ? "not a finite number" : `${typeName(value)}, not a number or null`}`,
    );
  }
}

function checkBoolean(wrong: string[], record: Record<string, unknown>, path: string, key = path): void {
  if (typeof record[key] !== "boolean") wrong.push(`${path} is ${typeName(record[key])}, not a boolean`);
}

/**
 * WHY EVERY FAILING FIELD IS NAMED AND NOT JUST THE FIRST. The sentence this
 * produces is the only thing an owner sees when a proxy, a stale route or a test
 * fixture answers `/api/supervisor`; "it was the wrong shape" without saying
 * which field is a dead end at 3am. Returns `null` when the body is one this
 * contract can be read from — never `true`, so a caller cannot read a truthy
 * failure as a pass.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CHECKS EVERY FIELD `SupervisorState` DECLARES, AND THAT WIDENING WAS BOUGHT
 * WITH A SECOND BLANK PAGE (2026-08-10).
 *
 * The first version checked the fields the ARMS below read; the second added the
 * two the detail pane reads and its own docblock argued the point — "an arm that
 * guards four of six fields guards nothing the day a body arrives missing the
 * other two". It was still enumerating crash sites one at a time, and the tree
 * that shipped with it had two more:
 *
 *   {"lastDefectSignature": {…}}  -> shortSignature() calls `.slice` on an
 *     object: `Uncaught TypeError: signature.slice is not a function` at
 *     `supervisor-strip.tsx:74` -> SupervisorStrip -> AppShell -> RootLayout.
 *     MEASURED as a red browser test, not reasoned about, and it is the SAME
 *     blank page as the `probe.wired` crash with a different field.
 *   {"ticket": {"ticketKey": {…}}} -> an object reaches JSX as a child and React
 *     refuses to render it.
 *
 * Enumerating dereference sites is the losing game: the set changes every time
 * anybody edits the component, and nothing tells you when it grew. The contract
 * does not change without somebody editing `api-types.ts`. So this validates
 * EVERY FIELD THE DECLARATION CARRIES — sixteen at the top level plus the members
 * of `ticket`, `run`, `attempts[]`, `lastDefect`, `lastRepair` and `probe` — and
 * the invariant it buys is worth stating exactly: A BODY THAT CLEARS THIS FUNCTION
 * CANNOT MAKE ANY CONSUMER OF `reading.snapshot` THROW, whatever it reads, because
 * every field is the type the type says it is.
 *
 * IT IS ALSO WHAT MAKES A MIRROR DRIFT VISIBLE INSTEAD OF FATAL, and that is now
 * measured rather than hoped for: when this file's `SupervisorState` disagreed with
 * the wire in fifteen fields, the strip read amber `MALFORMED` on every route
 * against the real server and named the eight it could see. Nothing crashed, and
 * nothing was readable either. The cure for that is not a looser validator — it is
 * `tests/fixtures/supervisor-wire.golden.json`, a body GENERATED by the server's own
 * composer and asserted from both ends, which turns the same drift into a red test.
 *
 * WHAT IT DELIBERATELY DOES NOT NARROW. `run.status`, `run.phase` and
 * `ticket.state` are checked as strings, not against their unions. `api-types.ts`
 * types `ticket.state` as `string` on purpose ("narrowing it here would make this
 * file disagree with the wire the first time the server adds a ninth state"), and a
 * strip that reported the whole reading unusable because a healthy server grew a
 * tenth phase would be the false-alarm failure this module exists to prevent.
 * Nothing dereferences those three beyond rendering them, so a string is enough.
 *
 * WHAT IT DELIBERATELY DOES NOT ACCEPT. `absent` where the contract says `| null`.
 * An extra field the server adds is IGNORED — only declared keys are inspected — so
 * a growing wire cannot flip a healthy supervisor to amber; but a field the server
 * DROPS, renames, or leaves `undefined` for `JSON.stringify` to delete is drift, and
 * treating it as `null` would report a fact about the supervisor that nothing sent.
 */
function malformedReasons(snapshot: SupervisorState): string | null {
  const body = snapshot as unknown;
  if (!isRecord(body)) {
    return `the body is ${typeName(body)}, not an object`;
  }
  const record = body;
  const wrong: string[] = [];

  const desired = record["desired"];
  if (typeof desired !== "string" || !KNOWN_DESIRED.includes(desired)) {
    wrong.push(
      `desired is ${desired === undefined ? "absent" : JSON.stringify(desired)}, not one of ${KNOWN_DESIRED.join("/")}`,
    );
  }
  checkString(wrong, record, "changedAt");
  checkString(wrong, record, "changedBy");
  checkString(wrong, record, "reason");
  checkString(wrong, record, "at");

  /*
   * `ticket` — `null` IS LEGAL AND MEANS "NOTHING IS CLAIMED", which arm 6 reads
   * as idle. A non-object is not, and neither is an object whose `ticketKey`
   * is not a string: the strip renders `ticket.ticketKey` as a JSX CHILD, and
   * React throws on an object child rather than printing it.
   */
  const ticket = record["ticket"];
  if (ticket !== null) {
    if (!isRecord(ticket)) {
      wrong.push(`ticket is ${typeName(ticket)} rather than an object or null`);
    } else {
      checkString(wrong, ticket, "ticket.ticketKey", "ticketKey");
      checkString(wrong, ticket, "ticket.title", "title");
      checkString(wrong, ticket, "ticket.state", "state");
      checkNumber(wrong, ticket, "ticket.attemptNo", "attemptNo");
      checkNumber(wrong, ticket, "ticket.maxAttempts", "maxAttempts");
    }
  }

  /*
   * `run` — NESTED, AND `null` MEANS THE SUPERVISOR NAMES NO RUN, which arm 8
   * reads as STUCK for a claimed ticket. `quietForMs` lives in here: it is the
   * one number that separates a working seat from one that died with the socket
   * open, so a body that carries the object without the clock is not a reading.
   */
  const run = record["run"];
  if (run !== null) {
    if (!isRecord(run)) {
      wrong.push(`run is ${typeName(run)} rather than an object or null`);
    } else {
      checkString(wrong, run, "run.runId", "runId");
      checkStringOrNull(wrong, run, "run.phase", "phase");
      checkString(wrong, run, "run.status", "status");
      checkNumberOrNull(wrong, run, "run.quietForMs", "quietForMs");
    }
  }

  /*
   * `attempts` — THE ELEMENTS ARE CHECKED, NOT ONLY THE ARRAY.
   *
   * `attemptProgress` reads `attempt.problems` and the detail pane renders each
   * `problem` as a JSX CHILD, so an element whose `problems` is an object is the
   * `lastDefectSignature`-object crash with a different field name. The array is
   * empty in this build; that is exactly when a shape check is cheap to get wrong
   * and impossible to notice.
   */
  const attempts = record["attempts"];
  if (!Array.isArray(attempts)) {
    wrong.push(`attempts is ${typeName(attempts)}, not an array`);
  } else {
    for (const [index, entry] of attempts.entries()) {
      const at = `attempts[${String(index)}]`;
      if (!isRecord(entry)) {
        wrong.push(`${at} is ${typeName(entry)}, not an object`);
        continue;
      }
      checkNumber(wrong, entry, `${at}.n`, "n");
      checkString(wrong, entry, `${at}.at`, "at");
      const problems = entry["problems"];
      if (!Array.isArray(problems)) {
        wrong.push(`${at}.problems is ${typeName(problems)}, not an array`);
      } else if (problems.some((problem) => typeof problem !== "string")) {
        wrong.push(`${at}.problems holds something that is not a string`);
      }
    }
  }

  /*
   * `lastDefect` — `null` IS THE ONLY VALUE THIS BUILD SENDS (`probe.unsourced`
   * names it), which is the reason to validate it now: the day a producer lands,
   * the panel dereferences `signature` and `.slice`s it, and that exact call on
   * an object threw `signature.slice is not a function` out of RootLayout once
   * already.
   */
  const lastDefect = record["lastDefect"];
  if (lastDefect !== null) {
    if (!isRecord(lastDefect)) {
      wrong.push(`lastDefect is ${typeName(lastDefect)} rather than an object or null`);
    } else {
      checkString(wrong, lastDefect, "lastDefect.signature", "signature");
      checkString(wrong, lastDefect, "lastDefect.failureClass", "failureClass");
      checkStringOrNull(wrong, lastDefect, "lastDefect.bakeoffCode", "bakeoffCode");
      checkString(wrong, lastDefect, "lastDefect.at", "at");
      checkBoolean(wrong, lastDefect, "lastDefect.repairable", "repairable");
    }
  }
  checkStringOrNull(wrong, record, "lastDefectId");

  /*
   * `lastRepair` IS NULLABLE ON THE WIRE and this build sends a literal `null`.
   * When it is an object the strip reads `patchId`, `appliedAt` and
   * `filesChanged.join(", ")`, so all three are checked; the SENTENCE about it is
   * composed by {@link repairSummary} on this side, because the wire carries no
   * `summary` field for the route to own.
   */
  const lastRepair = record["lastRepair"];
  if (lastRepair !== null) {
    if (!isRecord(lastRepair)) {
      wrong.push(`lastRepair is ${typeName(lastRepair)} rather than an object or null`);
    } else {
      if (!Array.isArray(lastRepair["filesChanged"])) {
        wrong.push(`lastRepair.filesChanged is not an array (it is ${typeName(lastRepair["filesChanged"])})`);
      } else if (lastRepair["filesChanged"].some((entry) => typeof entry !== "string")) {
        wrong.push("lastRepair.filesChanged holds something that is not a string");
      }
      checkString(wrong, lastRepair, "lastRepair.patchId", "patchId");
      checkString(wrong, lastRepair, "lastRepair.appliedAt", "appliedAt");
      if (lastRepair["rerunPassed"] !== null && typeof lastRepair["rerunPassed"] !== "boolean") {
        wrong.push(`lastRepair.rerunPassed is ${typeName(lastRepair["rerunPassed"])}, not a boolean or null`);
      }
    }
  }
  checkStringOrNull(wrong, record, "lastPatchId");

  /*
   * `lastRepairCycle` — CHECKED IF PRESENT, NOT REQUIRED, AND THE ASYMMETRY WITH
   * EVERY FIELD ABOVE IT IS THE POINT (added 2026-08-10).
   *
   * `grep -rn lastRepairCycle dashboard/server/src` → 0. Requiring it would turn
   * TODAY'S REAL BODY malformed, which is the fifteen-field amber recorded in the
   * docblock above — "Nothing crashed, and nothing was readable either" — and it
   * would arrive as a regression in the very pass that added a field to help.
   * `tests/supervisor-strip.unit.spec.ts`'s golden-body test is the gate that
   * catches that: if the body `composeSupervisorState` actually produces stops
   * classifying three ways, this block is wrong.
   *
   * WHAT IS STILL ENFORCED. If the key IS there it must be an object or null, and
   * every member must be its declared type or null — so the invariant survives:
   * a body that clears this function cannot make a consumer of `reading.snapshot`
   * throw. `repairCycleSummary` reads eight fields off this object and calls
   * `.trim()` on four of them; a `rollbackPoint` that arrived as an object would be
   * the `lastDefectSignature.slice` crash with a new field name.
   */
  const cycle = record["lastRepairCycle"];
  if (!isAbsent(record, "lastRepairCycle") && cycle !== null) {
    if (!isRecord(cycle)) {
      wrong.push(`lastRepairCycle is ${typeName(cycle)} rather than an object or null`);
    } else {
      checkOptionalString(wrong, cycle, "lastRepairCycle.signature", "signature");
      checkOptionalString(wrong, cycle, "lastRepairCycle.outcomeKind", "outcomeKind");
      checkOptionalString(wrong, cycle, "lastRepairCycle.outcomeCode", "outcomeCode");
      checkOptionalString(wrong, cycle, "lastRepairCycle.verdict", "verdict");
      checkOptionalString(wrong, cycle, "lastRepairCycle.fingerprint", "fingerprint");
      checkOptionalBoolean(wrong, cycle, "lastRepairCycle.applied", "applied");
      checkOptionalString(wrong, cycle, "lastRepairCycle.rollbackPoint", "rollbackPoint");
      checkOptionalString(wrong, cycle, "lastRepairCycle.detail", "detail");
      checkOptionalString(wrong, cycle, "lastRepairCycle.at", "at");
    }
  }

  checkNumber(wrong, record, "queueDepth");
  checkNumber(wrong, record, "queuedRuns");
  checkString(wrong, record, "nextAction");
  checkStringOrNull(wrong, record, "nextActionAt");

  /*
   * `probe` — AND ITS OWN FIELDS, WHICH IS A BEHAVIOUR CHANGE MADE ON PURPOSE.
   *
   * The earlier version checked that `probe` was an object and stopped, and its
   * test recorded `probe: {}` as a shape "this arm does NOT claim to catch":
   * `wired` reads `undefined`, arm 4 fires, nothing throws. That is true and it
   * is still the wrong answer. A body whose probe has no `wired` is not this
   * contract, and reporting it as "no supervisor wired" states a fact about the
   * SUPERVISOR that nothing sent — the same class of invention as painting a
   * default `desired` as a decision. It is now `malformed`, which is a fact about
   * the BODY, and the sentence names the field.
   */
  const probe = record["probe"];
  if (!isRecord(probe)) {
    wrong.push(`probe is ${typeName(probe)}, not an object`);
  } else {
    checkBoolean(wrong, probe, "probe.wired", "wired");
    checkBoolean(wrong, probe, "probe.armed", "armed");
    checkNumber(wrong, probe, "probe.ticketsSeen", "ticketsSeen");
    checkNumber(wrong, probe, "probe.runsSeen", "runsSeen");
    checkNumber(wrong, probe, "probe.eventsSeen", "eventsSeen");
    checkString(wrong, probe, "probe.armNote", "armNote");
    /*
     * `probe.unsourced` DECIDES WHAT THE PANEL SAYS ABOUT AN EMPTY TRAIL, so a
     * body without it is a body that cannot tell "nobody writes this yet" from
     * "nothing happened" — the distinction the whole attempts block exists for.
     */
    const unsourced = probe["unsourced"];
    if (!Array.isArray(unsourced)) {
      wrong.push(`probe.unsourced is ${typeName(unsourced)}, not an array`);
    } else if (unsourced.some((name) => typeof name !== "string")) {
      wrong.push("probe.unsourced holds something that is not a string");
    }
  }

  return wrong.length === 0 ? null : wrong.join("; ");
}

/* ------------------------------------------------------------------ */
/* THE OPTIONAL-FIELD CHECKS — `absent` IS A THIRD ANSWER, NOT A NULL   */
/* ------------------------------------------------------------------ */

/**
 * IS THE KEY MISSING — as opposed to present and `null`.
 *
 * `in` RATHER THAN `=== undefined`, and then `undefined` as well, which is not
 * belt-and-braces. `{"x": null}` and `{}` are different bodies and this whole
 * block exists to keep them apart, so `in` is the primitive that answers the
 * question. The `undefined` clause is for a JavaScript caller — a test literal or
 * a mirror with `x: undefined` — because `JSON.stringify` DELETES such a key, so
 * the value a producer would actually put on the wire is absent. Treating it as
 * present would make a unit fixture disagree with the byte stream it stands for.
 */
function isAbsent(record: Record<string, unknown>, key: string): boolean {
  return !(key in record) || record[key] === undefined;
}

/**
 * `T | null` IF THE KEY IS THERE, AND NOTHING AT ALL IF IT IS NOT.
 *
 * WHY THESE EXIST BESIDE `checkString` AND DO NOT REPLACE IT. `malformedReasons`
 * rejects `absent` wherever `SupervisorState` says `| null`, and that is correct
 * for a field the server has always sent: treating a dropped field as `null` would
 * report a fact about the supervisor that nothing transmitted. But a field whose
 * PRODUCER DOES NOT EXIST YET cannot be required, and the reason is measured
 * rather than aesthetic — a mirror that demanded fifteen fields the wire did not
 * send painted amber `MALFORMED` on every route in the app, and the note on
 * `malformedReasons` records the outcome exactly: "Nothing crashed, and nothing was
 * readable either."
 *
 * So an unlanded field is checked IF PRESENT and named as absent otherwise. The
 * naming is not optional: an absent column that produced no sentence would be
 * indistinguishable from a column that is there and null, which is the same
 * absence-as-a-value defect one layer down.
 */
function checkOptionalString(
  wrong: string[],
  record: Record<string, unknown>,
  path: string,
  key = path,
): void {
  if (isAbsent(record, key)) return;
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    wrong.push(`${path} is ${typeName(value)}, not a string or null`);
  }
}

function checkOptionalNumber(
  wrong: string[],
  record: Record<string, unknown>,
  path: string,
  key = path,
): void {
  if (isAbsent(record, key)) return;
  const value = record[key];
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    wrong.push(
      `${path} is ${
        typeof value === "number" ? "not a finite number" : `${typeName(value)}, not a number or null`
      }`,
    );
  }
}

function checkOptionalBoolean(
  wrong: string[],
  record: Record<string, unknown>,
  path: string,
  key = path,
): void {
  if (isAbsent(record, key)) return;
  const value = record[key];
  if (value !== null && typeof value !== "boolean") {
    wrong.push(`${path} is ${typeName(value)}, not a boolean or null`);
  }
}

/* ------------------------------------------------------------------ */
/* THE TICKET CENSUS — "IT FINISHED" vs "IT ALL DIED"                   */
/* ------------------------------------------------------------------ */

/**
 * THE EIGHT STATES, BUCKETED — AND THE NINTH, WHICH IS NOT BUCKETED.
 *
 * `queued` is its own bucket rather than part of `inFlight`, because the existing
 * ARM 6 already owns "running with a backlog and claiming nothing" and reads
 * `queueDepth` — the SAME rows — for it. Two buckets, two arms, no double count.
 */
const BACKLOG_STATES: readonly string[] = ["queued"];
const IN_FLIGHT_STATES: readonly string[] = ["claimed", "running", "repairing", "waiting"];
const DONE_STATES: readonly string[] = ["done"];
const FAILED_STATES: readonly string[] = ["blocked", "abandoned"];

export interface CensusCounts {
  readonly total: number;
  /** `queued`. */
  readonly backlog: number;
  /** `claimed` | `running` | `repairing` | `waiting`. */
  readonly inFlight: number;
  /** `done`. */
  readonly done: number;
  /**
   * `blocked` | `abandoned` — AND THE TWO ARE ADDED TOGETHER ON PURPOSE.
   *
   * They differ in who gave up (the loop bounded it, or a human/guard removed it)
   * and not in what the owner has to do about it: a ticket in either state did not
   * produce the work he asked for. The panel names them separately; the verdict
   * counts them together, because a headline that said "3 blocked" over a queue
   * with 3 blocked and 2 abandoned would undercount the failure.
   */
  readonly failed: number;
  /**
   * STATES THIS BUILD DOES NOT RECOGNISE, NAMED — AND THEY BLOCK EVERY VERDICT.
   *
   * THE POINT OF THE FIELD IS THAT AN UNKNOWN STATE IS NOT `done`. The server
   * types `state` as `string` so a ninth state cannot break the client, which
   * means a ninth state WILL arrive here one day. Folding it into any bucket
   * would let a queue full of a state this build has never heard of report
   * "finished, 9 done" — a confident answer built out of a word it could not
   * read. So an unrecognised state is counted nowhere, listed here, and
   * {@link censusVerdictBlocked} refuses to call the queue terminal while the
   * list is non-empty.
   */
  readonly unrecognised: readonly string[];
}

export function censusCounts(rows: readonly SupervisorTicketRow[]): CensusCounts {
  let backlog = 0;
  let inFlight = 0;
  let done = 0;
  let failed = 0;
  const unrecognised = new Set<string>();
  for (const row of rows) {
    const state = row.state.trim();
    if (BACKLOG_STATES.includes(state)) backlog += 1;
    else if (IN_FLIGHT_STATES.includes(state)) inFlight += 1;
    else if (DONE_STATES.includes(state)) done += 1;
    else if (FAILED_STATES.includes(state)) failed += 1;
    else unrecognised.add(state === "" ? "(blank)" : state);
  }
  return {
    total: rows.length,
    backlog,
    inFlight,
    done,
    failed,
    unrecognised: [...unrecognised].sort(),
  };
}

/**
 * MAY THE STRIP CLAIM THE QUEUE REACHED ITS END.
 *
 * Every clause is a way of NOT being able to claim it, which is the same shape as
 * the classifier's arm order: `terminal` is what is left when nothing disqualifies
 * it, never something asserted.
 */
export function censusIsTerminal(counts: CensusCounts): boolean {
  return (
    counts.total > 0 &&
    counts.backlog === 0 &&
    counts.inFlight === 0 &&
    counts.unrecognised.length === 0
  );
}

/** Exported only so the docblock above can name it. */
export const censusVerdictBlocked = censusIsTerminal;

/**
 * WHY THERE IS NO CENSUS, OR WHAT IT SAYS. Four answers, and the first three are
 * not interchangeable.
 *
 * `absent`      no body and no error — the first paint, or a route that has not
 *               answered yet. NOT an error and not a fact about the queue.
 * `unreachable` the read FAILED. Today's expected value: `GET
 *               /api/supervisor/tickets` does not exist (measured 2026-08-10 —
 *               only the POST does), so this is a 404 and the panel says the
 *               build has no census rather than blaming the loop.
 * `malformed`   something answered and it is not a census. Waiting will not fix
 *               it; the sentence names the fields, exactly as the state route's
 *               own `malformed` does.
 * `readable`    the rows are usable. ONLY THIS VALUE MAY PRODUCE A VERDICT.
 */
export type CensusAvailability = "absent" | "unreachable" | "malformed" | "readable";

export interface CensusReading {
  readonly availability: CensusAvailability;
  /** Never blank. Why there is no census, or the one line about the one there is. */
  readonly note: string;
  /** Non-null ONLY when `availability === "readable"`. */
  readonly counts: CensusCounts | null;
  /** The rows, or empty. Every element is validated when non-empty. */
  readonly rows: readonly SupervisorTicketRow[];
  /**
   * OPTIONAL COLUMNS THE ROUTE SENT ON NO ROW AT ALL, NAMED.
   *
   * The client-side `probe.unsourced`: the census route may land carrying eight of
   * twelve columns, and the four it omits must read as *this build does not report
   * that* rather than as `null` or as an empty cell. A column present on SOME rows
   * is not listed — the route carries it and the row genuinely has no value.
   */
  readonly absentFields: readonly string[];
  /** `blocked` and `abandoned` rows, newest `updatedAt` first. */
  readonly failedRows: readonly SupervisorTicketRow[];
  /**
   * The census route's own arm note, or a sentence saying it does not report one.
   *
   * NEVER BLANK, AND NEVER OPTIMISTIC. An absent probe reads as "this route reports
   * no arm check" — it does not read as armed, because a route that cannot say
   * whether it can see its own rows is the state a probe exists to expose.
   */
  readonly probeNote: string;
}

/**
 * EVERY COLUMN BEYOND THE TWO REQUIRED ONES, IN THE ORDER THE PANEL NAMES THEM —
 * and this list is the mirror's drift detector, not a wish list.
 *
 * RECONCILED AGAINST `ApiSupervisorTicketRow` ON 2026-08-10, AFTER THE ROUTE
 * LANDED MID-ROUND. The first version of this list carried `lastRunId`, which the
 * wire has never sent, and was missing `modelId`, `runId`, `currentRunId`,
 * `enqueuedAt` and `attachments`, which it does. Nothing dereferenced the wrong
 * name so nothing crashed — and `absentFields` would have printed "this build's
 * census does not carry lastRunId" for ever, about a column that was never coming.
 * That is the fifteen-field mirror failure in its quiet form: a panel confidently
 * naming a gap that does not exist.
 *
 * The route that landed sends ALL of these, so `absentFields` is EMPTY against a
 * healthy server, and a name appearing in it means the wire dropped a column.
 */
const ROW_OPTIONAL_FIELDS: readonly string[] = [
  "title",
  "modelId",
  "attemptNo",
  "maxAttempts",
  "nextAction",
  "nextActionAt",
  "enqueuedAt",
  "updatedAt",
  "runId",
  "currentRunId",
  "lastClass",
  "lastDefectId",
  "patchId",
  "attachments",
];

/**
 * IS THIS BODY A CENSUS — the same contract as {@link malformedReasons} and the
 * same invariant: a body that clears this cannot make a consumer of
 * `reading.census.rows` throw, whatever it reads, because every field is the type
 * the type says it is.
 *
 * `tickets` IS THE ONLY REQUIRED KEY, AND A ROW REQUIRES ONLY `ticketKey` AND
 * `state`. See rule 3 on {@link SupervisorTicketRow}: this mirror is written
 * against a route that does not exist, so requiring the columns a first version
 * might omit would turn a working count into a blank panel. The two that ARE
 * required are the two the count cannot be computed without.
 *
 * Returns `null` on a readable body — never `true`, so a caller cannot read a
 * truthy failure as a pass.
 */
function censusProblems(body: unknown): string | null {
  if (!isRecord(body)) return `the body is ${typeName(body)}, not an object`;
  const wrong: string[] = [];
  const tickets = body["tickets"];
  if (!Array.isArray(tickets)) {
    wrong.push(`tickets is ${typeName(tickets)}, not an array`);
  } else {
    for (const [index, entry] of tickets.entries()) {
      const at = `tickets[${String(index)}]`;
      if (!isRecord(entry)) {
        wrong.push(`${at} is ${typeName(entry)}, not an object`);
        continue;
      }
      checkString(wrong, entry, `${at}.ticketKey`, "ticketKey");
      checkString(wrong, entry, `${at}.state`, "state");
      checkOptionalString(wrong, entry, `${at}.title`, "title");
      checkOptionalString(wrong, entry, `${at}.modelId`, "modelId");
      checkOptionalNumber(wrong, entry, `${at}.attemptNo`, "attemptNo");
      checkOptionalNumber(wrong, entry, `${at}.maxAttempts`, "maxAttempts");
      checkOptionalString(wrong, entry, `${at}.nextAction`, "nextAction");
      checkOptionalString(wrong, entry, `${at}.nextActionAt`, "nextActionAt");
      checkOptionalString(wrong, entry, `${at}.enqueuedAt`, "enqueuedAt");
      checkOptionalString(wrong, entry, `${at}.updatedAt`, "updatedAt");
      checkOptionalString(wrong, entry, `${at}.runId`, "runId");
      checkOptionalString(wrong, entry, `${at}.currentRunId`, "currentRunId");
      checkOptionalString(wrong, entry, `${at}.lastClass`, "lastClass");
      checkOptionalString(wrong, entry, `${at}.lastDefectId`, "lastDefectId");
      checkOptionalString(wrong, entry, `${at}.patchId`, "patchId");
      /*
       * `attachments` — ITS MEMBERS ARE CHECKED EVEN THOUGH THIS READOUT DOES NOT
       * RENDER THEM YET, and that is the lesson from `lastDefect`: the day a panel
       * reads `attachments.manifest` and `.slice`s it, an object there is the
       * `signature.slice is not a function` crash out of RootLayout with a new
       * field name. The validator is over the CONTRACT, not over the set of
       * dereferences a component happens to have today.
       */
      const attachments = entry["attachments"];
      if (!isAbsent(entry, "attachments") && attachments !== null) {
        if (!isRecord(attachments)) {
          wrong.push(`${at}.attachments is ${typeName(attachments)} rather than an object or null`);
        } else {
          checkOptionalString(wrong, attachments, `${at}.attachments.manifest`, "manifest");
          checkOptionalNumber(wrong, attachments, `${at}.attachments.images`, "images");
          checkOptionalNumber(wrong, attachments, `${at}.attachments.documents`, "documents");
          checkOptionalBoolean(wrong, attachments, `${at}.attachments.capture`, "capture");
          checkOptionalBoolean(wrong, attachments, `${at}.attachments.motion`, "motion");
          checkOptionalBoolean(
            wrong,
            attachments,
            `${at}.attachments.carriedIntoRun`,
            "carriedIntoRun",
          );
        }
      }
    }
  }

  const probe = body["probe"];
  if (!isAbsent(body, "probe") && probe !== null) {
    if (!isRecord(probe)) {
      wrong.push(`probe is ${typeName(probe)} rather than an object or null`);
    } else {
      checkOptionalNumber(wrong, probe, "probe.ticketsSeen", "ticketsSeen");
      checkOptionalNumber(wrong, probe, "probe.manifestsUnreadable", "manifestsUnreadable");
      checkOptionalNumber(wrong, probe, "probe.attachmentsDropped", "attachmentsDropped");
      checkOptionalBoolean(wrong, probe, "probe.armed", "armed");
      checkOptionalString(wrong, probe, "probe.armNote", "armNote");
      checkOptionalString(wrong, probe, "probe.at", "at");
    }
  }

  return wrong.length === 0 ? null : wrong.join("; ");
}

/**
 * THE CENSUS ROUTE'S ARM CHECK, RENDERED — AND NEVER GUESSED AT.
 *
 * `ApiSupervisorTicketsProbe` always ships, so an absent probe means DRIFT, not an
 * early version, and the sentence for it says the route reports none. It must never
 * read as armed: a readout whose probe defaulted to healthy is the a913c871 watcher
 * that "would have printed a healthy seat forever after the seat died".
 *
 * `manifestsUnreadable` AND `attachmentsDropped` ARE PRINTED WHEN THEY ARE NON-ZERO
 * AND SILENT WHEN THEY ARE ZERO — the one place in this file where an absence is
 * allowed to be silent, because the probe has explicitly reported the number and
 * zero is the answer. That is different in kind from a field nothing sent.
 */
function censusProbeNote(census: SupervisorTicketCensus): string {
  const probe = census.probe;
  if (probe === undefined || probe === null) {
    /*
     * THIS IS DRIFT, NOT AN EARLY VERSION, AND THE SENTENCE HAS TO SAY SO
     * (corrected 2026-08-10, same pass as the `lastRunId` fix and for the same
     * reason). `ApiSupervisorTicketsResponse` has exactly two keys and `probe` is
     * one of them — the shipping route ALWAYS sends it. An earlier draft of this
     * sentence read as a benign build limitation, which is the `lastRunId` failure
     * inverted: a panel calmly describing as normal a field the wire has dropped.
     */
    return "the census route sent NO arm check, and `ApiSupervisorTicketsResponse` always carries one — so a field has been dropped between the route and this page. Nothing states whether the route can see the rows it is counting, and the counts above are this page's arithmetic on whatever arrived.";
  }
  const number = (value: number | null | undefined): string =>
    value === undefined || value === null ? "not reported" : String(value);
  const armed = probe.armed === undefined || probe.armed === null ? "not reported" : String(probe.armed);
  const note =
    probe.armNote === undefined || probe.armNote === null || probe.armNote.trim() === ""
      ? "the route sent no arm note"
      : probe.armNote;
  const alarms: string[] = [];
  if (typeof probe.manifestsUnreadable === "number" && probe.manifestsUnreadable > 0) {
    alarms.push(`${String(probe.manifestsUnreadable)} ticket manifest(s) would not parse`);
  }
  if (typeof probe.attachmentsDropped === "number" && probe.attachmentsDropped > 0) {
    alarms.push(
      `${String(probe.attachmentsDropped)} ticket(s) had attachments that did NOT reach their run`,
    );
  }
  return `census probe: armed=${armed}, ${number(probe.ticketsSeen)} row(s) read, composed ${
    probe.at === undefined || probe.at === null ? "at an unreported time" : probe.at
  } — ${note}${alarms.length === 0 ? "" : `. ${alarms.join("; ")}.`}`;
}

/**
 * THE CENSUS, READ ONCE, BEFORE ANY ARM — the same order and for the same reason
 * as the state body. See the note on {@link SupervisorReadingInput}: the
 * pre-parsed `attempts` input was REMOVED from this module because a caller could
 * only fill it from an unvalidated field, and `.map` then ran on it INSIDE the
 * function whose job was to survive a wrong-shaped body. A pre-parsed census
 * handed in from a component would rebuild that path exactly, so the raw body
 * comes in and the validation happens here.
 *
 * THERE IS NO SECOND STALE CLOCK, AND THAT IS A DELIBERATE LIMIT. The state
 * reading is aged against its own receipt time; the census is not. If the census
 * read FAILS this poll it is reported as unreachable rather than as last poll's
 * numbers — `useSupervisorTickets` turns `keepPreviousData` off for that reason —
 * so the failure mode a second clock would catch (a kept body rendered as
 * current) cannot arise. What is NOT caught: a census that keeps answering
 * successfully with rows it read minutes ago. The route would have to send `at`
 * and something would have to age against it; the field is declared and nothing
 * ages against it today.
 */
function readCensus(body: unknown, error: unknown): CensusReading {
  const blank = {
    counts: null,
    rows: [] as readonly SupervisorTicketRow[],
    absentFields: [] as readonly string[],
    failedRows: [] as readonly SupervisorTicketRow[],
    probeNote: "no census reading, so no census arm check",
  };

  if (error !== null && error !== undefined) {
    return {
      ...blank,
      availability: "unreachable",
      note: `GET /api/supervisor/tickets did not answer: ${errorText(
        error,
      )}. Until it does, this page cannot tell a queue that finished from a queue that all died — both leave nothing claimed and nothing queued.`,
    };
  }
  if (body === undefined || body === null) {
    return {
      ...blank,
      availability: "absent",
      note: "no ticket census has arrived yet, so the count of finished and blocked tickets is unknown. This is not a statement that the queue is empty.",
    };
  }

  const shape = censusProblems(body);
  if (shape !== null) {
    return {
      ...blank,
      availability: "malformed",
      note: `GET /api/supervisor/tickets answered with a body this page cannot read, so there is no census — the queue itself may be fine. Waiting will not fix this one. Fields: ${shape}`,
    };
  }

  const census = body as SupervisorTicketCensus;
  const rows = census.tickets;
  const counts = censusCounts(rows);
  const record = body as Record<string, unknown>;
  const rawRows = (record["tickets"] as readonly Record<string, unknown>[]);
  const absentFields = ROW_OPTIONAL_FIELDS.filter(
    (field) => rawRows.length > 0 && rawRows.every((row) => isAbsent(row, field)),
  );
  const failedRows = rows
    .filter((row) => FAILED_STATES.includes(row.state.trim()))
    /*
     * NEWEST FIRST, AND A ROW WITH NO `updatedAt` SORTS LAST RATHER THAN FIRST.
     * The panel shows the first one's `next_action` as the sentence to act on, and
     * a row whose clock the route did not send has no claim to being the newest —
     * putting it at the head would let a missing column decide which failure the
     * owner reads about.
     */
    .slice()
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));

  return {
    availability: "readable",
    note:
      counts.total === 0
        ? "the census answered and holds no ticket rows at all."
        : `${String(counts.total)} ticket row(s): ${String(counts.done)} done, ${String(
            counts.failed,
          )} blocked/abandoned, ${String(counts.backlog)} queued, ${String(
            counts.inFlight,
          )} in flight${
            counts.unrecognised.length === 0
              ? ""
              : `, and ${String(counts.unrecognised.length)} state(s) this build does not recognise (${counts.unrecognised.join(", ")})`
          }.`,
    counts,
    rows,
    absentFields,
    failedRows,
    probeNote: censusProbeNote(census),
  };
}

/**
 * THE SENTENCE THAT TELLS THE OWNER WHAT TO RUN BY HAND — item B of the brief,
 * and today it exists only in `supervisor_tickets.next_action`.
 *
 * NOT `SupervisorState.nextAction`. That is the SUPERVISOR's next action and the
 * strip has rendered it since the first version; this is the column on the failed
 * ticket's own row, which is where `NO_REPAIR_DRIVER` plus its sentence is filed.
 * The two were one field name apart and rendering the first over the second would
 * have looked like the feature working.
 *
 * WHEN THE COLUMN IS ABSENT IT SAYS SO AND NAMES WHERE THE STRING LIVES. A blank
 * would read as "there is nothing to do", which is the opposite of true for a
 * blocked ticket.
 */
export function failedTicketAction(rows: readonly SupervisorTicketRow[]): string {
  if (rows.length === 0) return "";
  const withAction = rows.find(
    (row) => typeof row.nextAction === "string" && row.nextAction.trim() !== "",
  );
  if (withAction === undefined) {
    const anyKeyed = rows.some((row) => row.nextAction !== undefined);
    return anyKeyed
      ? `${rows[0]?.ticketKey ?? "the newest failed ticket"} carries no next_action text, so nothing on this page can say what to run by hand — the column is on the wire and empty.`
      : "the census does not carry next_action, so the one sentence that says what to run by hand is still only in supervisor_tickets.next_action.";
  }
  const klass =
    typeof withAction.lastClass === "string" && withAction.lastClass.trim() !== ""
      ? ` (${withAction.lastClass})`
      : "";
  return `${withAction.ticketKey}${klass} says: ${String(withAction.nextAction)}`;
}

/* ------------------------------------------------------------------ */
/* THE REPAIR CYCLE — ITEM C, AND ITS THREE-WAY ABSENCE                */
/* ------------------------------------------------------------------ */

export interface RepairCycleReading {
  /**
   * `unreported` the field is not on the wire — NOBODY REPORTS THIS.
   * `null`       the route sent the field and says no cycle has run.
   * `reported`   a cycle ran and this is what it decided.
   *
   * THE FIRST TWO ARE NOT THE SAME SENTENCE AND MUST NOT BE. "No repair was
   * attempted" is a fact about the loop; "nothing reports repairs" is a fact about
   * this build. Printing the first over the second is how a dashboard tells its
   * owner the self-repair worked when the self-repair does not exist.
   */
  readonly kind: "unreported" | "null" | "reported";
  /** The 60px cell. Short, never blank. */
  readonly label: string;
  /** The sentence. Never blank. */
  readonly sentence: string;
}

/**
 * WHAT THE PANEL SAYS ABOUT THE LAST REPAIR CYCLE, IN ONE PLACE — the same rule
 * `repairSummary` follows and for the same reason: two components composing this
 * sentence is how they come to disagree about whether the machine fixed itself.
 *
 * IT IS A SECOND FUNCTION AND NOT AN EXTENSION OF `repairSummary`, BECAUSE THEY
 * ANSWER DIFFERENT QUESTIONS. `repairSummary` describes an APPLIED PATCH, and
 * `lastRepair` is null unless one was applied. Measured 2026-08-10:
 * `decideRepairOutcome` in `tools/repair/supervisor-cycle.mjs` has four arms and
 * exactly one of them applies anything — the other three (`NO_PATCH_AUTHOR`,
 * `NO_SANDBOX`, `ALREADY_RULED_OUT`) are complete, correct, ledger-written repair
 * cycles that change no file. So `repairSummary(null)` — "no patch has been
 * applied" — is true and useless for three quarters of the outcome space, and it
 * reads identically to "no repair was ever attempted".
 *
 * AN APPLIED PATCH WITH NO ROLLBACK POINT IS NAMED AS SUCH RATHER THAN LEFT
 * BLANK. A blank cell reads as "fine"; the owner's exposure in that case is a tree
 * edited by a machine with nothing recorded to undo it, which is the one fact he
 * would want in the first clause.
 */
export function repairCycleSummary(
  cycle: SupervisorRepairCycle | null | undefined,
): RepairCycleReading {
  if (cycle === undefined) {
    return {
      kind: "unreported",
      label: "not reported",
      sentence:
        "nothing in this build reports a repair cycle: lastRepairCycle is not on the wire. That is NOT the same as 'no repair was attempted' — this page cannot tell those two apart, and says so rather than printing 'none'.",
    };
  }
  if (cycle === null) {
    return {
      kind: "null",
      label: "none",
      sentence:
        "the route reports this field and says no repair cycle has run. This is an explicit null, not a missing field: something is watching, and it has nothing to report.",
    };
  }

  const missing: string[] = [];
  const value = (name: keyof SupervisorRepairCycle, shown: string | null): string => {
    if (shown === null) {
      missing.push(String(name));
      return "not reported";
    }
    return shown;
  };
  const signature = value(
    "signature",
    typeof cycle.signature === "string" ? cycle.signature : null,
  );
  const verdict = value("verdict", typeof cycle.verdict === "string" ? cycle.verdict : null);
  const code = value(
    "outcomeCode",
    typeof cycle.outcomeCode === "string" ? cycle.outcomeCode : null,
  );
  const kindWord = value(
    "outcomeKind",
    typeof cycle.outcomeKind === "string" ? cycle.outcomeKind : null,
  );

  /*
   * THREE ANSWERS FOR `applied`, AND THE THIRD IS THE ONE A `?:` CHECK WOULD EAT.
   * `false` is the honest answer for three of the four cycle outcomes; `null` is a
   * producer that sent the field and does not know; absent is nobody reporting. A
   * falsy test would print "changed nothing" over all three, which is a claim about
   * the working tree that two of them do not support.
   */
  const applied =
    cycle.applied === undefined
      ? "whether the tree was changed is not reported"
      : cycle.applied === null
        ? "the producer does not know whether the tree was changed"
        : cycle.applied
          ? "A PATCH WAS APPLIED to the tree"
          : "no file was changed";

  const rollback =
    typeof cycle.rollbackPoint === "string" && cycle.rollbackPoint.trim() !== ""
      ? `rollback point ${cycle.rollbackPoint}`
      : cycle.applied === true
        ? "AND NO ROLLBACK POINT WAS RECORDED — an applied patch with nothing to restore to is an edit, not a repair"
        : "no rollback point (nothing was applied to roll back)";

  const detail =
    typeof cycle.detail === "string" && cycle.detail.trim() !== "" ? ` ${cycle.detail.trim()}` : "";

  return {
    kind: "reported",
    label:
      typeof cycle.verdict === "string" && cycle.verdict.trim() !== ""
        ? cycle.verdict
        : typeof cycle.outcomeCode === "string" && cycle.outcomeCode.trim() !== ""
          ? cycle.outcomeCode
          : "reported",
    sentence: `repair cycle on defect ${signature}: ${kindWord}/${code}, ledger verdict ${verdict}; ${applied}, ${rollback}.${detail}${
      missing.length === 0 ? "" : ` Fields the producer did not send: ${missing.join(", ")}.`
    }`,
  };
}

function seconds(ms: number): string {
  if (ms < 90_000) return `${String(Math.max(0, Math.round(ms / 1000)))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${String(minutes)}m`;
  return `${String(Math.round(minutes / 60))}h`;
}

/**
 * The arms, in the order they are tested. THE ORDER IS LOAD-BEARING: every arm
 * above the last one is a reason `running` cannot be proved, so `running` is
 * what is LEFT when nothing else fires — never something asserted directly.
 */
export function classifySupervisor(
  input: SupervisorReadingInput,
): SupervisorReading {
  const { snapshot, error, receivedAtMs, nowMs, censusBody, censusError } = input;

  /*
   * THE SHAPE IS CHECKED ONCE, HERE, BEFORE ANY ARM — AND THAT MOVE CLOSED A
   * CRASH PATH NO TEST HAD REACHED (2026-08-10).
   *
   * It used to be checked inside arm 3b, i.e. AFTER the error and stale arms,
   * both of which keep the body and hand it out on `reading.snapshot`. So a
   * malformed 200 followed by a failed poll — a wrong route, then one dropped
   * request, which is a minute's worth of a restarting server — returned
   * `unreachable` WITH the malformed body attached, and `supervisor-strip.tsx`
   * dereferenced `snapshot.probe.wired` on it. That is the blank RootLayout
   * again, reached by a path the arm's own test did not cover.
   *
   * `readable` is the ONLY value any arm may publish, so the declaration on
   * `SupervisorReading.snapshot` becomes true for all five livenesses: non-null
   * implies every declared field is the declared type.
   */
  const shape = snapshot === null ? null : malformedReasons(snapshot);
  const readable = snapshot !== null && shape === null ? snapshot : null;

  /*
   * THE TRAIL IS READ FROM THE VALIDATED BODY, NOT PASSED IN BESIDE IT.
   * `attemptProgress` calls `.map` on it, so a caller handing over
   * `body.attempts` from an unchecked 200 would throw INSIDE this function —
   * before the arm written to catch exactly that could answer. Reading it here,
   * after validation, is what makes the comparator safe to feed from the wire.
   */
  const comparison = attemptProgress(readable?.attempts ?? []);
  /*
   * THE CENSUS IS READ HERE TOO, AND IT IS READ ON EVERY ARM INCLUDING THE ONES
   * THAT NEVER LOOK AT IT.
   *
   * A reading whose `census` were only filled on the arm that uses it would give
   * the panel two different meanings for the same empty region: "no census" on an
   * unreachable state route and "no census" on a readable one. The census is
   * INDEPENDENT of the state route — a 404 on one says nothing about the other —
   * so it is composed unconditionally and published on `base`, and the detail pane
   * can report its availability even while the strip is amber about the state.
   */
  const census = readCensus(censusBody, censusError);
  const base = {
    quietForMs: null,
    progress: comparison.progress,
    escalatesAtAttempt: comparison.escalatesAtAttempt,
    recurringPaths: comparison.recurringPaths,
    stale: false,
    snapshot: readable,
    census,
  };

  /* ARM 1 — nothing was ever read. */
  if (snapshot === null) {
    return {
      ...base,
      liveness: "unreachable",
      headline: "supervisor unreachable",
      because:
        error === null
          ? "the supervisor has not answered yet — this page has never had a reading from it."
          : `GET /api/supervisor did not answer: ${errorText(error)}`,
    };
  }

  /* ARM 2 — this read failed, so what is on screen is history, not state. */
  if (error !== null) {
    return {
      ...base,
      liveness: "unreachable",
      stale: true,
      headline: "supervisor unreachable",
      because: `GET /api/supervisor did not answer: ${errorText(error)}. The reading below is ${
        receivedAtMs === null ? "of unknown age" : `${seconds(nowMs - receivedAtMs)} old`
      } and is history, not state.`,
    };
  }

  /*
   * ARM 3 — the last good read is older than the poll, or there is no clock at
   * all. A snapshot that stopped moving keeps rendering and stops being true,
   * and nothing about it LOOKS wrong. `receivedAtMs === null` is the same
   * condition before the first tick, which is why the first paint is honest
   * rather than confidently green.
   */
  const age = receivedAtMs === null ? null : nowMs - receivedAtMs;
  if (age === null || age > STALE_AFTER_MS) {
    return {
      ...base,
      liveness: "unreachable",
      stale: true,
      headline: "reading is stale",
      because:
        age === null
          ? "this page has no clock for the reading below, so it cannot say whether it is current. Nothing here is live."
          : `the newest reading is ${seconds(age)} old against a 5s poll. Nothing here is live.`,
    };
  }

  /*
   * ARM 3b — THE ROUTE ANSWERED 200 WITH SOMETHING THAT IS NOT A SupervisorState.
   *
   * THIS ARM EXISTS BECAUSE ITS ABSENCE CRASHED THE WHOLE PAGE. Arms 1-3 can
   * observe no answer, a failed answer and a stale answer; none of them can
   * observe a MALFORMED answer, so a fresh, truthy, wrong-shaped body fell
   * through to arm 4, which dereferenced `snapshot.probe.wired` and threw
   * `Cannot read properties of undefined (reading 'wired')` out of
   * `SupervisorStrip` -> `AppShell` -> `RootLayout`. A throwing RootLayout
   * renders nothing at all: no strip, no canvas, no error — a blank page at 3am,
   * which is the worst possible answer for a strip whose entire job is telling
   * the owner whether the machine is alive.
   *
   * THE CHECK IS ON THE FIELDS SOMETHING ACTUALLY DEREFERENCES, and no others:
   * `probe` (arm 4/5), `ticket` (arm 6 onwards, where `null` is legal and a
   * non-object is not), `desired` (arm 6's sentence and the whole running/stopped
   * read), `queuedTickets` (arm 6's comparison), and `lastRepair` plus its
   * `filesChanged` — which no arm here touches and `supervisor-strip.tsx`'s detail
   * pane does. THE SCOPE WIDENED FROM "the arms below" TO "any consumer" ON
   * EVIDENCE: the first version guarded only the arms, and the component threw on
   * a field the arms never read. A body that clears this arm cannot make an arm
   * below it OR the strip throw; a body that fails it is `unreachable`, because a
   * reading whose shape is wrong is not a reading — and the reading it produces
   * carries `snapshot: null`, so a consumer cannot dereference it either way.
   *
   * WHAT IT DOES NOT CLAIM. `probe: {}` is NOT caught here — `wired` reads
   * `undefined`, arm 4 fires honestly, nothing throws — and this arm does not
   * validate `probe`'s own fields, so the note it prints may be blank rather
   * than absent. Both are recorded in the test rather than asserted away.
   */
  if (shape !== null) {
    return {
      ...base,
      /*
       * `snapshot: null`, OVERRIDING `base`, AND IT IS THE HALF OF THIS ARM THAT
       * WAS MISSING (added 2026-08-10 after it cost 77 browser failures).
       *
       * The first version of this arm stopped the classifier from throwing and
       * left `base.snapshot` — the malformed body — on the reading, under a field
       * DECLARED `SupervisorState | null`. That is a type lie, and every consumer
       * that believes the declaration dereferences it: `supervisor-strip.tsx:205`
       * did `snapshot.probe.wired` and threw `Cannot read properties of undefined
       * (reading 'wired')` out of `SupervisorStrip` -> `AppShell` -> `RootLayout`,
       * which renders NOTHING — no strip, no canvas, no error. The arm's own test
       * was titled "…and the strip never renders it as state" and asserted only
       * the three text fields, so the classifier went green while every page in
       * the app was blank. Measured: 80 failures across 11 browser spec files, 77
       * of them carrying that one line.
       *
       * Fixing the ONE dereference would have left the next one: the same
       * component reads `snapshot.lastRepair.summary`, `snapshot.probe.armNote`
       * and six more fields in its detail pane. A body that failed
       * `malformedReasons` is not a reading, so the reading carries no snapshot,
       * and the type becomes true rather than merely narrow.
       *
       * `stale: true` STAYS. The strip paints `data-stale` from it, and a 200 that
       * is not this contract is history in the only sense that matters here:
       * nothing on screen came from the supervisor.
       */
      snapshot: null,
      /*
       * `malformed`, NOT `unreachable`, AND THE OWNER'S NEXT MOVE IS THE REASON.
       * See `SupervisorLiveness`: an unreachable route may come back on its own,
       * and this one will not. The word is on the badge so it survives the row's
       * truncation, and the sentence says WHOSE fault it is not — a healthy
       * supervisor plus a wrong body reads identically from here, so the
       * sentence must not blame the run.
       */
      liveness: "malformed",
      stale: true,
      headline: "supervisor answered with the wrong body",
      /*
       * THE FIELD LIST GOES LAST, AND THAT ORDER WAS FIXED BY LOOKING AT THE
       * SCREENSHOT (2026-08-10). With `(${shape})` in the second clause the row
       * rendered "…answered 200 with a body this page cannot read (desired is
       * absent, not one of running/draining/stopped; since is absent, not a
       * string …" and the truncation at 1440px ate the only two clauses the owner
       * can act on. The row is `flex-1 truncate` by design — 30px, one line — so
       * sentence ORDER is what decides which half of a long sentence is legible
       * at a glance. Names of fields are for the detail pane, which shows the
       * whole string; the first clause has to answer "is my run broken" (no) and
       * "what do I do" (look at what is serving the path).
       */
      because: `the route answered 200 with a body this page cannot read, so nothing here is state — the supervisor itself may be fine. Check what is serving /api/supervisor: an old build, a proxy or a test fixture answers exactly like this. Fields: ${shape}`,
    };
  }

  /*
   * ARM 4 — THE ROUTE ANSWERED AND SAID THERE IS NOTHING BEHIND IT.
   *
   * `probe.wired === false` means every other field is a default. Rendering
   * `desired: "stopped"` from a default as though a supervisor had reported it
   * is precisely the confident-answer-without-support this module refuses.
   */
  if (!snapshot.probe.wired) {
    return {
      ...base,
      liveness: "unreachable",
      headline: "no supervisor wired",
      because: `the route answered but no supervisor is behind it, so every field it sent is a default. ${snapshot.probe.armNote}`,
    };
  }

  /*
   * ARM 5 — THE SERVER'S OWN ARM CHECK FAILED. It says it could not tell its
   * own outputs apart, which makes every field below unusable as evidence. Not
   * `unreachable` — the route is up and the fault is real — and certainly not
   * `running`.
   */
  if (!snapshot.probe.armed) {
    return {
      ...base,
      liveness: "stuck",
      headline: "supervisor arm check failed",
      because: `the supervisor route reports itself blind, so nothing it says about state can be trusted. ${snapshot.probe.armNote}`,
    };
  }

  const ticket = snapshot.ticket;

  /* ARM 6 — nothing is claimed: idle, or lying about being able to claim. */
  if (ticket === null) {
    if (snapshot.desired === "running" && snapshot.queueDepth > 0) {
      return {
        ...base,
        liveness: "stuck",
        headline: "running, claiming nothing",
        because: `the supervisor is set to running with ${String(
          snapshot.queueDepth,
        )} ticket(s) queued and has claimed none of them. ${snapshot.nextAction}`,
      };
    }

    /*
     * ─────────────────────────────────────────────────────────────────────────
     * ARM 6b — DID THE NIGHT WORK, OR DID EVERY TICKET DIE. THE MEASURED GAP.
     * ─────────────────────────────────────────────────────────────────────────
     *
     * Below this point the state route has told us everything it can: nothing is
     * claimed and nothing is queued. `SupervisorState` HAS NO FIELD THAT SEPARATES
     * THE TWO ENDINGS — `done`, `blocked` and `abandoned` are all "not queued and
     * not claimed", and `queueDepth` counts only `queued` (`http.ts:1256`). So
     * `IDLE / idle, queue empty` was rendered byte-identically for a queue that
     * finished and a queue where every ticket terminated at `blocked` with
     * NO_REPAIR_DRIVER. Eight hours of the owner's subscription window, one
     * sentence, no way to tell.
     *
     * EVERY BRANCH HERE IS GATED ON `availability === "readable"`, WHICH IS WHAT
     * MAKES THIS ADDITIVE RATHER THAN A REWRITE. The census route does not exist
     * yet, so every input that predates it — including every existing test in
     * `supervisor-strip.unit.spec.ts` and the golden body the server actually
     * composes — falls straight through to the sentence below, unchanged. If an ARM
     * 6 test goes red, something was changed that should not have been.
     *
     * WHAT THIS ARM DELIBERATELY REFUSES TO CLAIM, AND WHY THE REFUSAL IS THE
     * DESIGN. A census that names rows `claimed` or `running` while `/api/supervisor`
     * claims no ticket looks like a wedged loop, and it is the strongest signal in
     * this data — but the two routes are polled 5 s and 15 s apart, so ONE tick of
     * that disagreement is a race, not a fault, and a red strip on it would be the
     * false alarm this module exists to prevent (see the preview card that announced
     * a healthy backend was down). So in-flight rows do not produce a verdict; they
     * only DISQUALIFY the terminal claim, and the count is reported in the panel
     * with the disagreement stated in words. Catching a genuinely wedged `claimed`
     * row needs an age on the census, which the route does not send.
     */
    if (census.availability === "readable" && census.counts !== null) {
      const counts = census.counts;
      /*
       * WHO STOPPED IT STAYS IN THE SENTENCE, AND THIS CLAUSE IS THE FIX FOR
       * SOMETHING ARM 6b BROKE ON ITS WAY IN.
       *
       * The fall-through below answers a non-running supervisor with
       * `${changedBy} set it to ${desired}: ${reason}` — the only place the page
       * says WHO drained the loop and why. ARM 6b fires regardless of `desired`, so
       * a drained supervisor whose tickets had all finished lost that clause: the
       * row read "queue finished · 6 done" with no hint that nothing more will be
       * claimed until somebody presses start. Nothing false was claimed, and the
       * owner would still have waited all morning for a seventh ticket.
       */
      const stopNote =
        snapshot.desired === "running"
          ? ""
          : ` Nothing more will be claimed: ${snapshot.changedBy} set the supervisor to ${snapshot.desired} — ${snapshot.reason}.`;
      if (censusIsTerminal(counts)) {
        if (counts.failed > 0) {
          return {
            ...base,
            /*
             * RED, AND A WORD OF ITS OWN. See `SupervisorLiveness`: the arm check
             * compares liveness strings, so a distinction that lived only in this
             * headline would be one the strip could not prove it can still make.
             */
            liveness: "blocked",
            headline: `queue ended · ${String(counts.failed)} blocked`,
            because: `the queue reached its end and ${String(
              counts.failed,
            )} of ${String(counts.total)} ticket(s) ended blocked or abandoned (${String(
              counts.done,
            )} done). This is NOT the same as an empty queue. ${failedTicketAction(
              census.failedRows,
            )}${stopNote}`,
          };
        }
        return {
          ...base,
          liveness: "idle",
          /*
           * `idle` WITH A DIFFERENT HEADLINE, AND THE HEADLINE IS WHAT THE ARM
           * CHECK MEASURES FOR THIS PAIR. "Everything finished" and "nothing was
           * ever filed" are both genuinely idle — neither is a fault and neither
           * needs the owner to do anything — so inventing a sixth colour for
           * success would tell him to act on a machine that behaved. The arm check
           * compares `liveness + headline` for these two rather than liveness
           * alone, which is why collapsing them still says BLIND.
           */
          headline: `queue finished · ${String(counts.done)} done`,
          because: `every ticket the loop was given reached done: ${String(
            counts.done,
          )} of ${String(counts.total)}. Nothing is queued and nothing is claimed, and this time that is a finished queue rather than an empty one. ${snapshot.nextAction}${stopNote}`,
        };
      }
      if (counts.total === 0) {
        return {
          ...base,
          liveness: "idle",
          headline: "idle, no tickets filed",
          because: `the census holds no ticket rows at all, so this queue has not finished — it has never been given anything. ${snapshot.nextAction}${stopNote}`,
        };
      }
      /*
       * READABLE, NOT TERMINAL, AND NOTHING CLAIMED. Backlog with the supervisor
       * stopped, in-flight rows the state route does not corroborate, or a state
       * this build cannot read. No verdict is available and the census's own note
       * says which of the three it is, so the fall-through below carries it into
       * the sentence instead of asserting anything.
       */
    }

    return {
      ...base,
      liveness: "idle",
      headline:
        snapshot.desired === "running"
          ? "idle, queue empty"
          : `${snapshot.desired}, nothing in flight`,
      because:
        snapshot.desired === "running"
          ? /*
             * THE CENSUS CAVEAT IS IN THIS SENTENCE, NOT ONLY IN THE PANEL, AND IT
             * IS THE HALF OF THE FIX THAT SHIPS TODAY.
             *
             * ARM 6b cannot fire without a census route, and there is no census
             * route yet. So on this build the owner still lands on `idle, queue
             * empty` after eight hours — and the sentence beside it must not be the
             * same confident sentence it was, because the confidence is exactly
             * what has no data behind it. `census.note` names WHICH of the four
             * answers applies (nothing arrived / the read failed / the body is not
             * a census / it is readable but not terminal), which is more than "we
             * do not know" and is composed in one place.
             */
            `nothing is queued (${String(
              snapshot.probe.ticketsSeen,
            )} ticket row(s) read). ${snapshot.nextAction} ${census.note}`
          : `${snapshot.changedBy} set it to ${snapshot.desired}: ${snapshot.reason}`,
    };
  }

  const attemptOf = `attempt ${String(ticket.attemptNo)} of ${String(ticket.maxAttempts)}`;
  /*
   * MILLISECONDS STRAIGHT OFF THE WIRE, AND NO ARITHMETIC ON THE WAY IN. The
   * first mirror declared `quietForSeconds` and multiplied by 1000 here, against a
   * wire that sends `run.quietForMs` — so the strip's own clock was `absent * 1000`
   * on every real poll. Null when there is no run, and null when there IS a run
   * whose clock had nothing to read: arm 9 refuses to call either one `running`.
   */
  const run = snapshot.run;
  const quietForMs = run?.quietForMs ?? null;

  /*
   * ARM 7 — THE LOOP HAS PROVED ITS OWN FEEDBACK CHANNEL NON-CONVERGENT.
   *
   * This is a913c871 and it is the arm no counter and no silence threshold can
   * reach: three attempts, budget never exceeded, events flowing the whole
   * time, and the third attempt re-broke a field the second had fixed. Dormant
   * until the route reports `attempts`; armed and tested regardless.
   */
  if (
    comparison.escalatesAtAttempt !== null &&
    ticket.attemptNo >= comparison.escalatesAtAttempt
  ) {
    return {
      ...base,
      quietForMs,
      liveness: "stuck",
      headline: "looping, not converging",
      because:
        comparison.progress === "oscillating"
          ? `${attemptOf}: ${comparison.recurringPaths.join(
              ", ",
            )} was rejected, fixed, and rejected again. The feedback channel cannot converge; another attempt is spend, not progress.`
          : `${attemptOf}: the rejection set stopped shrinking at attempt ${String(
              comparison.escalatesAtAttempt,
            )} (${comparison.progress}). Another attempt is spend, not progress.`,
    };
  }

  /* ARM 8 — claimed, but there is no run behind it. */
  if (run === null) {
    return {
      ...base,
      liveness: "stuck",
      headline: "claimed, no run",
      because: `${ticket.ticketKey} is ${ticket.state} and the supervisor names no run for it. ${snapshot.nextAction}`,
    };
  }

  /* ARM 9 — a run with no progress clock. `running` is not provable. */
  if (quietForMs === null) {
    return {
      ...base,
      liveness: "stuck",
      headline: "no progress clock",
      because: `${run.runId} is ${run.status} in ${
        run.phase ?? "an unnamed phase"
      } and the supervisor reports no time since its last event, so nothing here can show it is alive.`,
    };
  }

  /* ARM 10 — alive but silent past the measured ceiling. */
  if (quietForMs > STUCK_AFTER_MS) {
    return {
      ...base,
      quietForMs,
      liveness: "stuck",
      headline: "silent too long",
      because: `no event on ${run.runId} for ${seconds(
        quietForMs,
      )}, past the ${seconds(STUCK_AFTER_MS)} ceiling. Rate-limit frames are excluded from that clock.`,
    };
  }

  /* ARM 11 — what is left. */
  return {
    ...base,
    quietForMs,
    liveness: "running",
    headline: `${run.phase ?? "running"} · ${attemptOf}`,
    because: `${run.runId} is ${run.status}; last event ${seconds(quietForMs)} ago. ${
      snapshot.nextAction
    }`,
  };
}

/* ------------------------------------------------------------------ */
/* THE ONE SENTENCE ABOUT THE LAST PATCH                               */
/* ------------------------------------------------------------------ */

/**
 * WHAT THE STRIP SAYS ABOUT `lastRepair`, IN ONE PLACE.
 *
 * The wire sends `{patchId, filesChanged, appliedAt, rerunPassed} | null` and NO
 * `summary`. The first mirror invented one and declared the route owned it, which
 * meant the component read a field that has never existed. Rather than have two
 * components compose their own version of this sentence — the disagreement the
 * invented field was meant to prevent — it is composed HERE, where the unit spec
 * can drive all four shapes: no patch, a patch whose re-run has not finished, one
 * that passed, one that failed.
 *
 * `rerunPassed === null` IS NOT `false`. "The confirming re-run has not finished"
 * and "the confirming re-run failed" are the difference between waiting and
 * reverting, and a falsy check would print the second over the first.
 */
export function repairSummary(repair: SupervisorRepair | null): string {
  if (repair === null) return "no patch has been applied";
  const rerun =
    repair.rerunPassed === null
      ? "the confirming re-run has not finished"
      : repair.rerunPassed
        ? "the confirming re-run passed"
        : "the confirming re-run FAILED";
  const files =
    repair.filesChanged.length === 0
      ? "no files named"
      : `${String(repair.filesChanged.length)} file(s)`;
  return `${repair.patchId} at ${repair.appliedAt}, ${files}; ${rerun}`;
}

/* ------------------------------------------------------------------ */
/* THE START-UP ARM CHECK                                              */
/* ------------------------------------------------------------------ */

export interface ArmProbe {
  readonly name: string;
  readonly expected: string;
  readonly got: string;
  readonly ok: boolean;
}

export interface ArmReport {
  readonly armed: boolean;
  /** One line, printed whether it passed or failed. Never blank. */
  readonly line: string;
  readonly probes: readonly ArmProbe[];
  readonly distinct: number;
}

/**
 * THE ARM CHECK'S SYNTHETIC BODIES, AND THEY ARE WIRE-SHAPED BY CONSTRUCTION.
 *
 * `Partial<SupervisorState>` is what keeps them honest: the mirror is the wire's
 * shape, so a field this file renames without renaming on the server stops
 * compiling here — which is the check the ORIGINAL version of this function could
 * not perform, because it was built from a mirror nothing else agreed with. The
 * golden-body test in `tests/supervisor-strip.unit.spec.ts` is what closes the
 * remaining gap: this stub proves the classifier can tell five states apart, the
 * golden proves those states are reachable from the body the server sends.
 */
function stubState(over: Partial<SupervisorState>): SupervisorState {
  return {
    desired: "running",
    changedAt: "2026-08-10T00:00:00.000Z",
    changedBy: "owner",
    reason: "arm check",
    at: "2026-08-10T00:00:00.000Z",
    ticket: null,
    run: null,
    attempts: [],
    lastDefect: null,
    lastDefectId: null,
    lastRepair: null,
    lastPatchId: null,
    nextAction: "arm check",
    nextActionAt: null,
    queueDepth: 0,
    queuedRuns: 0,
    probe: {
      ticketsSeen: 0,
      runsSeen: 0,
      eventsSeen: 0,
      wired: true,
      armed: true,
      armNote: "arm check",
      unsourced: ["attempts", "lastDefect", "lastRepair"],
    },
    ...over,
  };
}

const ARM_TICKET = {
  ticketKey: "t-arm",
  title: "arm check",
  state: "running",
  attemptNo: 1,
  maxAttempts: 3,
} as const;

/** a913c871's three real rejection sets, in the order the run produced them. */
export const A913C871_ATTEMPTS: readonly SupervisorAttemptView[] = [
  { n: 1, at: "2026-08-09T21:31:52.000Z", problems: ["dataExpectations[0].id"] },
  { n: 2, at: "2026-08-09T22:07:19.000Z", problems: ["dataExpectations[0].kind"] },
  { n: 3, at: "2026-08-09T22:31:03.000Z", problems: ["dataExpectations[0].id"] },
];

/**
 * ONE PROBE'S ANSWER, AND A THROW IS AN ANSWER.
 *
 * EXPORTED SO THAT THE `try` BELOW HAS A TEST AND NOT ONLY A MUTATION
 * TRANSCRIPT. `armSupervisorStrip` composes its probes internally, so nothing
 * outside this module could reach the catch — and a guard nothing can reach is a
 * guard the next edit deletes. `supervisor-strip.unit.spec.ts` drives this
 * directly with a body whose `probe` getter throws, which no JSON can produce and
 * a hostile object can, and asserts the STRING rather than the crash.
 *
 * Returning `threw: …` rather than a liveness is the point: it matches no
 * `expected`, so the probe fails, `armed` goes false, and the strip renders
 * "THE SUPERVISOR STRIP IS BLIND" naming the input. The alternative — letting it
 * propagate — was measured: this function runs inside `useState`'s initialiser,
 * i.e. IN THE RENDER BODY ON THE SERVER, where React error boundaries do not
 * catch. A throw here is a blank page that `RenderGuard` cannot save, and the
 * failure it produced under mutation M2 was `Timed out waiting 180000ms from
 * config.webServer` — a message that names neither this strip nor the field.
 */
export function probeLiveness(
  snapshot: SupervisorState | null,
  error: unknown,
  nowMs: number,
  censusBody: unknown = null,
): string {
  return probeVerdict(snapshot, error, nowMs, censusBody).liveness;
}

/**
 * THE SAME PROBE, RETURNING THE HEADLINE TOO — and the headline is not decoration
 * here, it is the only thing that can prove one of the distinctions this strip
 * makes.
 *
 * "The queue finished, six done" and "nothing was ever filed" are BOTH `idle`, on
 * purpose: neither is a fault, neither asks the owner to do anything, and
 * inventing a sixth colour for success would tell him to act on a machine that
 * behaved. But they must not read the same, and the arm check's whole method is
 * requiring N known inputs to produce N DIFFERENT answers. Comparing livenesses
 * alone cannot see that pair, so the arm compares `liveness · headline` for it —
 * which means collapsing the two headlines makes the arm say BLIND, exactly as
 * collapsing `blocked` onto `idle` does.
 */
export function probeVerdict(
  snapshot: SupervisorState | null,
  error: unknown,
  nowMs: number,
  censusBody: unknown = null,
): { readonly liveness: string; readonly headline: string; readonly verdict: string } {
  try {
    const reading = classifySupervisor({
      snapshot,
      error,
      receivedAtMs: nowMs - 1_000,
      nowMs,
      censusBody,
      censusError: null,
    });
    return {
      liveness: reading.liveness,
      headline: reading.headline,
      verdict: `${reading.liveness} · ${reading.headline}`,
    };
  } catch (caught) {
    const threw = `threw: ${caught instanceof Error ? caught.message : String(caught)}`;
    return { liveness: threw, headline: threw, verdict: threw };
  }
}

/**
 * RUN THIS WHILE THE ANSWER IS KNOWN, AT MOUNT, EVERY TIME.
 *
 * The precedent is `RUN-a913c871-observations.md`: a watcher built to catch
 * finding 1 had finding 1's defect, printed `0.0% cpu, 38 MB` at an idle HTTP
 * server, and "would have printed a healthy seat forever after the seat died".
 * A classifier that returns one constant is indistinguishable from a healthy
 * system, so five inputs with five KNOWN answers go through the REAL
 * `classifySupervisor` — not a copy of its rules — and all five answers must be
 * both correct AND different from one another. Correctness alone is not enough:
 * `return "running"` gets one of the five right.
 *
 * THE FIFTH PROBE IS `malformed`, AND IT WAS ADDED IN THE SAME EDIT AS THE STATE
 * (2026-08-10). The defect this whole strip exists to avoid is a check that can
 * only observe success, and the brief that ordered this fix names its own cause:
 * "a three-state arm check was specified, the component got one for unreachable
 * and none for reachable-but-malformed". Shipping a fifth always-on state under a
 * four-probe arm would have been that defect one layer up — the arm would print
 * "4 distinct" forever while the newest state was unreachable code. Its negative
 * control is in the unit spec: make `malformedReasons` return `null` and this
 * probe collapses onto `idle`, `distinct` reads 4, and the arm says BLIND.
 *
 * THE SIXTH PROBE IS `blocked` AND IT WAS ADDED FOR THE SAME REASON, ONE ROUND
 * LATER (2026-08-10, second pass). The five-probe arm printed "5 distinct" and the
 * count was true; shipping a sixth always-on state under it would have left the
 * state the owner needs at 7am — the queue that ended with every ticket blocked —
 * as code nothing measured. Its negative control is the mutation in the unit spec:
 * make `censusIsTerminal` return false and this probe collapses onto `idle`,
 * `distinct` reads 5, and the arm says BLIND.
 *
 * THREE MORE PROBES MEASURE DISTINCTIONS THAT DO NOT SHOW UP IN A LIVENESS. The
 * three idle endings ("finished", "never filed", "cannot tell") are compared as
 * `liveness · headline`, because a distinction that lives only in prose is one the
 * arm cannot see; the census reader's four availabilities are compared because a
 * reader that could not tell a 404 from an empty queue would feed the arm above a
 * confident verdict built on nothing; and the repair cycle's `unreported`/`null`
 * pair is compared because printing "no repair was attempted" over "nothing
 * reports repairs" is how a dashboard claims a self-repair it does not have.
 *
 * The last two probes are the comparator's two directions. A comparator that
 * always escalates is exactly as useless as one that never does, so the shrinking
 * control is not decoration.
 */
export function armSupervisorStrip(
  nowMs = Date.parse("2026-08-10T00:00:00.000Z"),
): ArmReport {
  const probes: ArmProbe[] = [];
  const check = (name: string, expected: string, got: string): void => {
    probes.push({ name, expected, got, ok: expected === got });
  };
  /*
   * A PROBE THAT THROWS IS A FAILED PROBE, NOT A DEAD PAGE — AND THIS `try` WAS
   * PUT HERE BY A MUTATION, NOT BY CAUTION (2026-08-10).
   *
   * THIS FUNCTION IS THE ONE PATH IN THE STRIP THAT RUNS DURING THE SERVER
   * RENDER. `useState(armSupervisorStrip)` evaluates its initialiser in the
   * render body, on the server as well as the client, and unlike every other
   * read in the component it does not depend on `data` — so it is reachable
   * before hydration, with synthetic inputs, EVERY TIME. React error boundaries
   * do not catch server-render throws, which makes this the one place where
   * `RenderGuard` cannot help and a throw is a blank page again.
   *
   * MEASURED: blinding `malformedReasons` (mutation M2) let the missing-`probe`
   * probe below fall through to arm 4, which threw `Cannot read properties of
   * undefined (reading 'wired')` INSIDE THE SERVER RENDER. The dev server never
   * became ready and the whole suite died on `Timed out waiting 180000ms from
   * config.webServer` — a failure that names neither the strip nor the field.
   *
   * So a throw is CAUGHT AND REPORTED AS THE ANSWER IT IS. `got` becomes
   * `threw: …`, which matches no `expected`, so the probe fails, `armed` is
   * false, and the strip renders the alarm saying which known input made the
   * classifier throw. That is strictly more than the old arm could see: it used
   * to be able to observe a WRONG answer and not a fatal one.
   */
  const read = (snapshot: SupervisorState | null, error: unknown): string =>
    probeLiveness(snapshot, error, nowMs);

  check("unreachable", "unreachable", read(null, new Error("connection refused")));
  check("idle", "idle", read(stubState({ desired: "stopped" }), null));
  check(
    "running",
    "running",
    read(
      stubState({
        ticket: ARM_TICKET,
        run: { runId: "run-arm", phase: "build", status: "running", quietForMs: 30_000 },
      }),
      null,
    ),
  );
  check(
    "stuck",
    "stuck",
    read(
      stubState({
        ticket: ARM_TICKET,
        run: {
          runId: "run-arm",
          phase: "spec",
          status: "running",
          quietForMs: STUCK_AFTER_MS + 60_000,
        },
      }),
      null,
    ),
  );

  /*
   * A BODY THAT IS FRESH, TRUTHY AND NOT THIS CONTRACT — `probe` deleted, which
   * is exactly what the ten catch-all specs and the shipped server route both
   * send. It must answer `malformed`, and it must not answer `idle`: the whole
   * arm turns on those two being tellable apart.
   */
  const missingProbe = ((): SupervisorState => {
    const stripped = { ...stubState({}) } as Record<string, unknown>;
    delete stripped["probe"];
    return stripped as unknown as SupervisorState;
  })();
  check("malformed", "malformed", read(missingProbe, null));

  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * THE SIXTH LIVENESS PROBE — `blocked`, AND THE ARM WOULD HAVE BEEN A LIE
   * WITHOUT IT.
   * ─────────────────────────────────────────────────────────────────────────────
   *
   * The five probes above were shipped as "five distinct states" and the count was
   * true. Adding a sixth always-on liveness under a five-probe arm is the exact
   * defect the `malformed` probe's own docblock names one paragraph up: the arm
   * would print "5 distinct" for ever while the newest state — the one the owner
   * needs at 7am — was unreachable code nothing measured.
   *
   * THE INPUT IS THE STATE THE OWNER ACTUALLY CAME BACK TO: nothing claimed,
   * nothing queued, and a census in which a ticket ended `blocked`. It must answer
   * `blocked` and it must NOT answer `idle`; the whole gap this round closed is
   * those two being byte-identical.
   */
  const censusOf = (rows: readonly Record<string, unknown>[]): unknown => ({ tickets: rows });
  const CENSUS_BLOCKED = censusOf([
    { ticketKey: "t-arm-1", state: "done" },
    {
      ticketKey: "t-arm-2",
      state: "blocked",
      updatedAt: "2026-08-10T00:00:00.000Z",
      nextAction: "no repair driver is wired; run tools/repair/cycle.mjs by hand",
    },
  ]);
  const CENSUS_ALL_DONE = censusOf([
    { ticketKey: "t-arm-1", state: "done" },
    { ticketKey: "t-arm-2", state: "done" },
  ]);
  const CENSUS_EMPTY = censusOf([]);

  check(
    "blocked",
    "blocked",
    probeLiveness(stubState({}), null, nowMs, CENSUS_BLOCKED),
  );

  /*
   * THE HEADLINE PAIRS — THREE ENDINGS THAT ARE NOT ALL DIFFERENT LIVENESSES.
   *
   * "the queue finished", "nothing was ever filed" and "nothing is queued and this
   * page cannot tell which" are all honestly `idle`: none is a fault and none asks
   * the owner to act, so none may be painted red. That makes them invisible to a
   * distinctness check on livenesses alone — so this probe compares the full
   * `liveness · headline` verdict and requires THREE DIFFERENT ones. Collapse any
   * two of those headlines and this probe reports `2 of 3` and the arm says BLIND,
   * which is the same guarantee the liveness count gives the other six states.
   */
  const finished = probeVerdict(stubState({}), null, nowMs, CENSUS_ALL_DONE).verdict;
  const neverFiled = probeVerdict(stubState({}), null, nowMs, CENSUS_EMPTY).verdict;
  const noCensus = probeVerdict(stubState({}), null, nowMs, null).verdict;
  const idleVerdicts = new Set([finished, neverFiled, noCensus]);
  check(
    "the three idle endings do not read the same",
    "3 of 3 distinct",
    `${String(idleVerdicts.size)} of 3 distinct`,
  );

  /*
   * THE CENSUS READER'S OWN FOUR ANSWERS. `readCensus` decides whether ARM 6b may
   * speak at all, so a reader that collapsed "the route 404s" onto "the route
   * answered and the queue is empty" would hand the arm above a confident verdict
   * built on nothing. Four known inputs, four different availabilities, and the
   * failure is named rather than counted.
   */
  const availabilities = [
    readCensus(null, null).availability,
    readCensus(null, new Error("404 not found")).availability,
    readCensus({ tickets: "not an array" }, null).availability,
    readCensus(CENSUS_ALL_DONE, null).availability,
  ];
  check(
    "the census reader tells its four answers apart",
    "absent · unreachable · malformed · readable",
    availabilities.join(" · "),
  );

  /*
   * THE REPAIR CYCLE'S THREE-WAY ABSENCE. `undefined` (nobody reports repairs),
   * `null` (the route reports and has nothing) and a value are three different
   * sentences, and the first two are the pair that matters: printing "no repair was
   * attempted" over "nothing reports repairs" is how a dashboard tells its owner
   * the self-repair worked when the self-repair does not exist.
   */
  const cycleKinds = [
    repairCycleSummary(undefined).kind,
    repairCycleSummary(null).kind,
    repairCycleSummary({ outcomeCode: "NO_PATCH_AUTHOR", applied: false }).kind,
  ];
  check(
    "the repair cycle tells unreported from null from reported",
    "unreported · null · reported",
    cycleKinds.join(" · "),
  );

  const oscillation = attemptProgress(A913C871_ATTEMPTS);
  check(
    "comparator escalates a913c871 at attempt 2",
    "oscillating@2",
    `${oscillation.progress}@${String(oscillation.escalatesAtAttempt)}`,
  );

  const at = "2026-08-10T00:00:00.000Z";
  const shrinking = attemptProgress([
    { n: 1, at, problems: ["a.id", "a.kind", "a.minRows"] },
    { n: 2, at, problems: ["a.id", "a.kind"] },
    { n: 3, at, problems: ["a.id"] },
  ]);
  check(
    "comparator clears a shrinking sequence",
    "shrinking@null",
    `${shrinking.progress}@${String(shrinking.escalatesAtAttempt)}`,
  );

  /*
   * SIX, NOT FIVE — AND THE CONSTANT AND THE SLICE MOVE TOGETHER OR THE CHECK
   * SILENTLY WEAKENS. `slice(0, 6)` has to cover exactly the liveness probes and
   * `distinct === 6` has to be the count of them; leaving either at 5 while adding
   * a sixth state is how an arm check keeps printing a pass about a state it no
   * longer looks at.
   */
  const LIVENESS_PROBES = 6;
  const livenesses = probes.slice(0, LIVENESS_PROBES).map((probe) => probe.got);
  const distinct = new Set(livenesses).size;
  const failures = probes.filter((probe) => !probe.ok);
  const armed = failures.length === 0 && distinct === LIVENESS_PROBES;

  /*
   * THE LINE SAYS WHAT IS WIRED, NOT WHAT WAS WIRED WHEN IT WAS WRITTEN.
   *
   * This is the same rule the SERVER's boot line is being held to this round: it
   * used to announce "NO REPAIR DRIVER is wired", and when the driver landed that
   * sentence became a lie in the one place an operator reads for the truth. So the
   * census clause below is composed from `readCensus`'s ACTUAL answer for the arm's
   * own fixture rather than from a literal — and the pass branch names the two
   * distinctions this round added, so a reader can tell a line printed by this
   * version from one printed by the version that could not see them.
   *
   * IT CAN STILL SAY BLIND, WHICH IS THE HALF THAT MATTERS. Every clause of the
   * pass branch is derived: collapse `blocked` onto `idle` and `distinct` is 5;
   * collapse two idle headlines and that probe fails; blind `readCensus` and its
   * probe fails. Any one of them takes the whole line to the failure branch with
   * the collapsed pair named.
   */
  const line = armed
    ? `ARM CHECK: supervisor strip resolves ${String(LIVENESS_PROBES)} known inputs to ${livenesses.join(
        " · ",
      )} (${String(
        distinct,
      )} distinct); it tells a FINISHED queue from an ALL-BLOCKED one and from one that was never given anything; the census reader tells absent/unreachable/malformed/readable apart and the repair cycle tells unreported from null; comparator escalates a913c871 at attempt ${String(
        oscillation.escalatesAtAttempt,
      )} and clears a shrinking sequence`
    : `ARM CHECK FAILED — THE SUPERVISOR STRIP IS BLIND: ${
        distinct === LIVENESS_PROBES
          ? ""
          : `only ${String(distinct)} of ${String(
              LIVENESS_PROBES,
            )} states are distinguishable (${livenesses.join(" · ")}); `
      }${failures
        .map((probe) => `${probe.name} expected ${probe.expected}, got ${probe.got}`)
        .join("; ")}`;

  return { armed, line, probes, distinct };
}
