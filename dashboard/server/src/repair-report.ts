/**
 * repair-report.ts — what the machine tells the owner after it has repaired
 * itself, written for somebody who is not at a terminal.
 *
 * ─── THE BRIEF, VERBATIM ───
 *
 * The owner, 2026-08-16: *"it sent an email to me on what went wrong and what
 * it's done to fix it, as a summary with natural human language that's easy to
 * understand."*
 *
 * ─── THE HALF EVERYBODY FORGETS, AND WHY IT IS THE PRODUCT ───
 *
 * A repair report has two halves and only the first is fun to write:
 *
 *   1. WHAT IT DID — what broke, what changed, and the proof: the fault was
 *      watched happening BEFORE the fix, the fix stopped it, undoing the fix
 *      brought it back, and the test suites are green.
 *   2. WHAT IT COULD NOT DECIDE — the questions that belong to the owner.
 *
 * **A report that only says what went well is this repository's signature
 * defect wearing a nicer font.** The standing rule here is *"a check that can
 * only observe success is not a check"*, catalogued twenty times in
 * `DESIGN-self-maintaining-pipeline.md` §5.3; a summary that can only report
 * success is the same shape. So section 2 is NOT conditional on there being
 * something to say. It is always rendered, in three distinguishable states, and
 * the third is the one that matters:
 *
 *   questions.length > 0                 here is what needs you, and why
 *   none, and the list was compiled      nothing needed you, and that was checked
 *   none, and it could NOT be compiled   I cannot tell you what needs you
 *
 * The third state exists because absence is not emptiness — the same argument
 * `defect-record.ts:208` makes for `violationsAvailable`, where `[]` would
 * otherwise read as *"the classifier looked and found none"*. A report that
 * silently prints "nothing needed you" when nobody looked is worse than one
 * that prints nothing at all, because it is believed.
 *
 * ─── WHERE THE CONTRACT CAME FROM (UNVERIFIED DOC REFERENCE, NAMED) ───
 *
 * The lane brief cites `docs/DESIGN-repair-lane-2026-08-16.md` §10.4 / §11.2.
 * **That file does not exist in this tree** (`ls docs/` on 2026-08-16 lists no
 * such document, and the design that does exist,
 * `DESIGN-self-maintaining-pipeline.md`, has 10 sections — its §10.4 is the
 * supervisor `#finish` hook and the two-queue hazard, and there is no §11). So
 * the shape below is derived from the brief itself plus the sections of the
 * existing design that DO govern this material: §5.3 (the evidence bar — the
 * three transcripts this report's proof section reads), §3.6 (the four classes
 * that must always stop and require the owner) and §10.5 (the owner-only
 * decisions). Marked UNVERIFIED rather than presented as ratified.
 *
 * ─── WHAT THE OWNER HALF IS FED BY, SO IT IS NOT DECORATION ───
 *
 * {@link OwnerQuestion} is shaped so the producers already in the tree map onto
 * it with no translation layer. Measured 2026-08-16:
 *
 *   `tools/tier3/gate.mjs:270,337,378`   verdict `SELF-PROPOSE` + `reason` →
 *                                        id `SELF-PROPOSE`, `why` = the reason
 *   `repair-author.ts:240`               `REFUSED_PATH_PREFIXES[].why` is
 *                                        already owner-facing prose → `why`
 *   design §3.6                          `budget_exceeded`, `missing_credential`,
 *                                        publishing personal data, any diff
 *                                        reaching the FROZEN set
 *   `tools/tier3/trail.mjs:108`          `humanReviewed === null && applied` —
 *                                        that filter IS "nobody has decided this"
 *
 * ─── THREE MECHANICAL RULES ABOUT THE TEXT, EACH WITH A TEST ───
 *
 * 1. NO CREDENTIAL. Every rendered byte goes through
 *    `repair-mail.ts#scrubUrlCredentials`. This is not paranoia about this
 *    file's own code — nothing here reads `REPAIR_SMTP_URL` — it is about the
 *    DATA: `DefectRecord.failureReason` is carried verbatim from a thrown error
 *    (`defect-record.ts:213`, *"NOTHING in this program parses it"*), and
 *    `connect ECONNREFUSED smtp://user:pw@host` is exactly the kind of sentence
 *    a mail-adjacent failure throws.
 * 2. NO STACK TRACES. The brief says so; {@link stripStackFrames} makes it
 *    mechanical rather than editorial, because the prose that reaches this
 *    report is written by whatever threw.
 * 3. NO HOST PATHS THAT NAME A PERSON. `/Users/<name>/…` becomes `~/…`. Design
 *    §3.6 item 1 makes *anything naming a person leaving this machine* an
 *    owner-only decision, and an email leaves this machine. `ticket-refs.ts`
 *    already refuses absolute host paths in front of a seat for the neighbouring
 *    reason.
 *
 * ─── WHAT IS NOT HERE ───
 *
 * NOTHING CALLS THIS YET. The wiring — supervisor `#finish` / the repair
 * driver's terminal transition — is deliberately not in this lane, and
 * `index.ts`, `supervisor.ts` and `orchestrator.ts` are untouched. Named as
 * carried-forward rather than implied to be done.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeSegment } from "./paths.js";
import { SMTP_CODES, describeSmtpTarget, resolveRepairMailConfig, safeSubject, scrubUrlCredentials, sendRepairMail } from "./repair-mail.js";
import type { RepairMailRequest, RepairMailResult } from "./repair-mail.js";

/** Subdirectory of the dashboard's results root. One file per report. */
/**
 * The report directory NAME, and it must stay equal to the segment
 * `gate-attempts.ts#repairReportsRoot` denies.
 *
 * TWO SPELLINGS OF ONE PATH IS HOW A WRITER LANDS OUTSIDE ITS OWN DENY — this
 * file's neighbours record that happening twice already (`results/scores`,
 * 2026-07-30, and the attempt archive before it). This module takes a
 * `resultsDir` string rather than `DashboardPaths`, so it cannot call the root
 * function directly without inverting its signature; the binding is therefore a
 * TEST that asserts the two agree, in `repair-report.test.ts`. A constant with a
 * test pinning it to its deny is a binding; a constant with a comment is not.
 */
export const REPAIR_REPORT_DIRNAME = "repair-reports";

/** Body width. Long enough for a sentence, narrow enough for a phone. */
const WIDTH = 78;

/* =========================================================================
 * The input
 * ====================================================================== */

/** What a single test suite did. `not-run` is NEVER folded into either other value. */
export interface RepairSuiteResult {
  /** How the owner would name it: "the dashboard server's tests". */
  readonly name: string;
  readonly state: "green" | "red" | "not-run";
  /** One clause. "412 tests, no failures" / "not run: no container available". */
  readonly detail: string;
}

/**
 * One leg of the evidence bar (design §5.3).
 *
 * `observed` IS NOT A BOOLEAN WITH A NICER NAME. Three states, because "we
 * watched it fail" (`observed`), "we ran it and it did not fail" (`contradicted`)
 * and "we never ran it" (`not-run`) are three different facts, and only the
 * first supports the claim. §5.3's rule is that a patch missing any of the three
 * transcripts is refused and *"absence is treated exactly like failure"*.
 */
export interface RepairProofStep {
  readonly state: "observed" | "contradicted" | "not-run";
  /** One clause a non-programmer can read. Never a transcript. */
  readonly note: string;
}

export interface RepairProof {
  /** The fault was made to happen on purpose, BEFORE anything was changed. */
  readonly failedFirst: RepairProofStep;
  /** With the change in place, it stopped happening. */
  readonly fixedAfter: RepairProofStep;
  /** With the change undone, it came back. THE ONE THAT MAKES THE OTHER TWO MEAN ANYTHING. */
  readonly brokeAgainWhenUndone: RepairProofStep;
  /** Where the three raw transcripts live, for somebody who does want them. */
  readonly transcriptsAt: string | null;
}

export interface RepairChange {
  /** Repository-relative. Absolute host paths are scrubbed on the way out anyway. */
  readonly path: string;
  /** What changed in that file, in one sentence, in plain words. */
  readonly what: string;
}

/** A question only the owner may answer. See the module docblock for producers. */
export interface OwnerQuestion {
  /** A short stable token: `SELF-PROPOSE`, `frozen-closure`, `budget_exceeded`. */
  readonly id: string;
  /** The question, phrased as a question. */
  readonly question: string;
  /** Why the machine is not allowed to answer it. The rule, not an apology. */
  readonly why: string;
  /** Which mechanism raised it, so the owner can go and look. */
  readonly source: string;
  /** What happened in the meantime — an unanswered question must not be a mystery. */
  readonly meanwhile: string;
}

export interface RepairReportInput {
  readonly at: string;
  readonly runId: string | null;
  readonly ticketKey: string | null;
  /** The defect signature. Shortened in the text; kept whole in the filename. */
  readonly signature: string | null;
  /** What happened in the end. Drives the first line and the subject. */
  readonly outcome: "applied" | "refused" | "inconclusive";
  /** One sentence: what this whole report says. */
  readonly headline: string;
  /** What broke, in plain English. May be several sentences. No jargon without a gloss. */
  readonly whatBroke: string;
  /** Terms this report could not avoid, each with a one-line meaning. */
  readonly glossary: readonly { readonly term: string; readonly meaning: string }[];
  readonly changes: readonly RepairChange[];
  readonly proof: RepairProof;
  readonly suites: readonly RepairSuiteResult[];
  readonly questions: readonly OwnerQuestion[];
  /**
   * FALSE MEANS NOBODY LOOKED, and it is not the same as an empty list. See the
   * module docblock; the pattern is `defect-record.ts:208`.
   */
  readonly questionsAvailable: boolean;
  /** Required when `questionsAvailable` is false: why the list could not be built. */
  readonly questionsUnavailableReason: string | null;
  /** Where this report and the run's own files can be found, in plain words. */
  readonly recordNote: string | null;
  /** What was done about delivery. Written by {@link deliverRepairReport}. */
  readonly mailNote: string | null;
}

/* =========================================================================
 * Text hygiene — the three mechanical rules
 * ====================================================================== */

/**
 * Stack frames out, one honest sentence in.
 *
 * MATCHES V8's SHAPE, WHICH IS WHAT ARRIVES HERE. `at fn (/path/file.ts:12:3)`,
 * `at /path/file.ts:12:3`, `at async Foo.bar (…)`. A run of consecutive frames
 * collapses to a single replacement line so the reader is told something was
 * removed rather than silently handed a truncated error.
 */
export function stripStackFrames(text: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of text.split("\n")) {
    if (/^\s*at\s+\S.*:\d+:\d+\)?\s*$/.test(line) || /^\s*at\s+\S+\s+\(<anonymous>\)\s*$/.test(line)) {
      if (!dropping) out.push("  (the technical trace is left out here; it is in the run's own record)");
      dropping = true;
      continue;
    }
    dropping = false;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * `/Users/somebody/x` → `~/x`.
 *
 * The owner's home directory carries his name, this text is emailed, and design
 * §3.6 item 1 makes anything naming a person leaving this machine an owner-only
 * decision. `file://` URLs are covered by the same pass.
 */
export function scrubHostPaths(text: string): string {
  return text.replace(/(?:file:\/\/)?\/(?:Users|home)\/[^/\s"'()]+/g, "~");
}

/**
 * Every rule in the module docblock, in the order that cannot un-hide anything.
 *
 * `secrets` IS THE ARM THAT CATCHES A BARE PASSWORD, and it exists because
 * `URL.password` DECODES. A password written `a%2Fb` in `REPAIR_SMTP_URL` is
 * `a/b` by the time anything uses it, and a sentence that quotes the decoded
 * form — an SMTP library's error, a config dump, a mistaken interpolation — is
 * not a URL and no pattern can recognise it. So the one caller that legitimately
 * knows the value ({@link deliverRepairReport}, which already has the
 * environment) passes it down, and everything else gets the URL-shaped rule
 * alone.
 *
 * THE LIMIT, NAMED: `renderRepairReport` called directly with no `secrets` can
 * only redact userinfo it can see inside a URL. That is why the production path
 * is `deliverRepairReport`, and why this parameter is not optional-by-accident
 * but documented here.
 */
export function sanitiseReportText(text: string, secrets: readonly string[] = []): string {
  return scrubHostPaths(stripStackFrames(scrubUrlCredentials(text, secrets)));
}

/**
 * A single untrusted value on one line of the report.
 *
 * SANITISED HERE AND NOT ONLY AT THE END, and the reason is a bug this test
 * suite caught rather than a preference. {@link stripStackFrames} is
 * LINE-ORIENTED, and {@link wrap} re-flows prose to {@link WIDTH} — so a stack
 * frame that arrives inside `whatBroke` has already been folded into the middle
 * of a wrapped line by the time a whole-document pass runs, and the frame
 * regex no longer matches. MEASURED 2026-08-16: the *"a stack trace is replaced
 * by one honest sentence"* test was RED for exactly this reason before the
 * sanitiser moved in front of the wrapper.
 *
 * The final whole-document pass in {@link renderRepairReport} is kept anyway as
 * the backstop that covers anything composed after this point.
 */
function oneLine(value: string): string {
  return sanitiseReportText(value).replace(/\s+/g, " ").trim();
}

/* =========================================================================
 * Rendering
 * ====================================================================== */

/**
 * Prose, sanitised and then folded to {@link WIDTH}.
 *
 * THE SANITISE HAPPENS BEFORE THE FOLD. See {@link oneLine} — a line-oriented
 * rule cannot run after the lines have been rearranged.
 */
function wrap(raw: string, indent: string, firstIndent: string = indent): readonly string[] {
  const text = sanitiseReportText(raw);
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (out.length > 0) out.push("");
    let prefix = out.length === 0 ? firstIndent : indent;
    let line = prefix;
    for (const word of paragraph.split(/\s+/).filter((w) => w !== "")) {
      if (line.trim() !== "" && line.length + word.length + 1 > WIDTH) {
        out.push(line);
        prefix = indent;
        line = prefix;
      }
      line = line.trim() === "" ? `${prefix}${word}` : `${line} ${word}`;
    }
    if (line.trim() !== "") out.push(line);
  }
  return out.length > 0 ? out : [`${indent}(nothing recorded)`];
}

function heading(title: string): readonly string[] {
  return ["", title, "-".repeat(title.length)];
}

const OUTCOME_WORDS: Readonly<Record<RepairReportInput["outcome"], string>> = Object.freeze({
  applied: "a fix was made and it is now in place",
  refused: "a fix was attempted and rejected, so nothing was changed",
  inconclusive: "no fix could be reached, so nothing was changed",
});

const STEP_WORDS: Readonly<Record<RepairProofStep["state"], string>> = Object.freeze({
  observed: "YES",
  contradicted: "NO",
  "not-run": "NOT CHECKED",
});

/**
 * Is the three-legged proof complete?
 *
 * ALL THREE OR NONE. §5.3: *"A patch whose bundle is missing any of the three
 * transcripts is refused by the queue. Absence is treated exactly like
 * failure."* The renderer uses this to decide whether it is allowed to say the
 * repair is proved — a report that claims proof from two legs is the failure
 * mode this whole document is about.
 */
export function proofHolds(proof: RepairProof): boolean {
  return (
    proof.failedFirst.state === "observed" &&
    proof.fixedAfter.state === "observed" &&
    proof.brokeAgainWhenUndone.state === "observed"
  );
}

export interface SuiteTally {
  readonly green: number;
  readonly total: number;
  readonly red: readonly string[];
  readonly notRun: readonly string[];
}

/**
 * IS THE REPAIR PROVED? THE THREE LEGS ARE NOT ENOUGH, AND THAT IS THE WHOLE
 * REASON THIS FUNCTION EXISTS BESIDE {@link proofHolds}.
 *
 * The brief's definition of the proof has FOUR parts, not three: *"reproduction
 * went red, patch made it green, reverting made it red again, all four suites
 * green."* A version of this renderer that read only `proofHolds` printed *"All
 * three held, so the change is what fixed it"* directly above a line naming a
 * suite that was still failing — a success sentence stacked on top of a failure
 * line, inside the section built to prevent precisely that.
 *
 * `total > 0` IS PART OF THE CONJUNCTION. A repair that ran no suite at all has
 * an empty tally with nothing red in it, and "nothing was red" out of nothing
 * run is the emptiness-is-not-absence trap in arithmetic form.
 *
 * HOW MANY SUITES THERE ARE IS NOT ASSERTED HERE. The brief says "four"; this
 * tree has three package suites (`bakeoff`, `dashboard`, `dashboard/server`)
 * plus the `tools/**\/*.test.mjs` files that no package script runs, and which
 * of those a repair cycle executes is the caller's measurement, not this
 * module's guess. So the renderer reports N of M from what it is handed and
 * names every suite that is red or was never run.
 */
export function repairIsProved(proof: RepairProof, suites: readonly RepairSuiteResult[]): boolean {
  const tally = tallySuites(suites);
  return proofHolds(proof) && tally.total > 0 && tally.red.length === 0 && tally.notRun.length === 0;
}

/** `not-run` is counted as neither green nor red. It gets named instead. */
export function tallySuites(suites: readonly RepairSuiteResult[]): SuiteTally {
  return {
    green: suites.filter((s) => s.state === "green").length,
    total: suites.length,
    red: suites.filter((s) => s.state === "red").map((s) => s.name),
    notRun: suites.filter((s) => s.state === "not-run").map((s) => s.name),
  };
}

/** `2026-08-16 at 09:14 UTC` — no ISO string in front of a non-technical reader. */
export function humanInstant(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "at an unrecorded time";
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${String(at.getUTCFullYear())}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())} at ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}

/**
 * The subject line. Says the outcome first, because that is what a phone shows
 * before the reader decides whether to open anything.
 *
 * IT GOES THROUGH `safeSubject` (`repair-mail.ts`) RATHER THAN A SECOND
 * SANITISER OF ITS OWN: that function is the one that has to hold on the wire —
 * it strips the CR/LF that would inject a header and flattens the em dashes
 * this repository writes everywhere into ASCII, so no encoded word is needed.
 * Building the subject here and cleaning it there would mean two rules for one
 * string, and the wire's rule is the one that is not negotiable.
 */
export function repairReportSubject(input: RepairReportInput, secrets: readonly string[] = []): string {
  const owner = input.questionsAvailable && input.questions.length > 0 ? `, ${String(input.questions.length)} for you` : "";
  const what = input.outcome === "applied" ? "fixed itself" : input.outcome === "refused" ? "rejected its own fix" : "could not fix itself";
  return safeSubject(sanitiseReportText(`The dashboard ${what}${owner} — ${input.headline}`, secrets));
}

/**
 * THE REPORT. Two halves, both always present.
 *
 * The last thing this function does is {@link sanitiseReportText} over the
 * WHOLE document — not over each field — so a field added next year by somebody
 * who has not read this docblock is covered by construction. (The per-field
 * pass inside {@link wrap} is a SECOND, earlier application, needed only
 * because stripping stack frames is line-oriented; see {@link oneLine}.)
 *
 * `secrets` reaches only that final pass, which is the pass that sees every
 * byte. See {@link sanitiseReportText}.
 */
export function renderRepairReport(input: RepairReportInput, secrets: readonly string[] = []): string {
  const lines: string[] = [];
  const tally = tallySuites(input.suites);

  lines.push("WHAT THE DASHBOARD DID WHILE YOU WERE AWAY");
  lines.push("=".repeat(42));
  lines.push("");
  lines.push(...wrap(input.headline, ""));
  lines.push("");
  lines.push(`In short: ${OUTCOME_WORDS[input.outcome]}.`);
  lines.push(`When: ${humanInstant(input.at)}.`);
  if (input.runId !== null) lines.push(`The job this came from: ${oneLine(input.runId)}.`);
  if (input.signature !== null) lines.push(`The fault's reference number: ${oneLine(input.signature.slice(0, 12))}.`);

  lines.push(...heading("1. WHAT WENT WRONG"));
  lines.push(...wrap(input.whatBroke, "  "));

  lines.push(...heading("2. WHAT I CHANGED"));
  if (input.changes.length === 0) {
    lines.push(...wrap("Nothing. No file on this machine was changed by this repair.", "  "));
  } else {
    for (const change of input.changes) {
      lines.push(`  ${oneLine(change.path)}`);
      lines.push(...wrap(change.what, "      "));
    }
  }

  lines.push(...heading("3. HOW I KNOW IT WORKS"));
  lines.push(...wrap(
    "Three checks, in this order. The third is the one that matters: undoing the fix has to bring " +
      "the fault back, otherwise the first two prove nothing about the fix.",
    "  ",
  ));
  lines.push("");
  lines.push(`  [${STEP_WORDS[input.proof.failedFirst.state]}] I made the fault happen on purpose, before changing anything.`);
  lines.push(...wrap(input.proof.failedFirst.note, "        "));
  lines.push(`  [${STEP_WORDS[input.proof.fixedAfter.state]}] With the change in place, it stopped happening.`);
  lines.push(...wrap(input.proof.fixedAfter.note, "        "));
  lines.push(`  [${STEP_WORDS[input.proof.brokeAgainWhenUndone.state]}] With the change undone again, the fault came straight back.`);
  lines.push(...wrap(input.proof.brokeAgainWhenUndone.note, "        "));
  lines.push("");
  if (tally.total === 0) {
    lines.push(...wrap("And no test suite was run at all, so nothing here says the rest of the system still works.", "  "));
  } else {
    lines.push(`  Test suites: ${String(tally.green)} of ${String(tally.total)} green.`);
    for (const suite of input.suites) {
      lines.push(`    ${suite.state === "green" ? "green" : suite.state === "red" ? "RED" : "not run"} - ${oneLine(suite.name)}: ${oneLine(suite.detail)}`);
    }
    if (tally.red.length > 0) lines.push(...wrap(`Still failing: ${tally.red.join(", ")}.`, "  "));
    if (tally.notRun.length > 0) {
      lines.push(...wrap(`Never run, so nothing is known about them either way: ${tally.notRun.join(", ")}.`, "  "));
    }
  }
  if (input.proof.transcriptsAt !== null) {
    lines.push(...wrap(`The raw output of all three checks is kept at ${input.proof.transcriptsAt}.`, "  "));
  }
  /*
   * ─── THE VERDICT COMES LAST, AND IT READS THE SUITES AS WELL AS THE LEGS ───
   * Three branches, because there are three different situations and only one
   * of them is "proved". Printing the success sentence BEFORE the suite list —
   * which is what this section did first — put "the change is what fixed it"
   * directly above a line naming a suite that was still failing. See
   * {@link repairIsProved}.
   */
  lines.push("");
  if (repairIsProved(input.proof, input.suites)) {
    lines.push(...wrap(
      "All three checks held and every test suite came back green, so the change is what fixed it, and " +
        "nothing else broke on the way.",
      "  ",
    ));
  } else if (proofHolds(input.proof)) {
    lines.push(...wrap(
      "All three checks held, BUT the test suites above are not all green, so this repair is NOT proved " +
        "end to end. The fix does what it says; what is not established is that the rest of the system " +
        "still works — and a suite nobody ran counts here exactly like a suite that failed.",
      "  ",
    ));
  } else {
    lines.push(...wrap(
      "NOT ALL THREE CHECKS HELD, so this repair is NOT proved. A missing check counts the same as a " +
        "failed one here: without all three, nothing above shows that the change is what made the difference.",
      "  ",
    ));
  }

  /*
   * ─── SECTION 4 IS NEVER OMITTED ───
   * See the module docblock. Deleting this block, or making it conditional on
   * `questions.length > 0`, is the mutation `repair-report.test.ts` runs.
   */
  lines.push(...heading("4. WHAT I COULD NOT DECIDE — THIS PART IS FOR YOU"));
  if (!input.questionsAvailable) {
    lines.push(...wrap(
      "I CANNOT TELL YOU WHAT WAS LEFT UNDECIDED. " +
        (input.questionsUnavailableReason ?? "The list of open questions could not be built, and no reason was recorded.") +
        " Treat that as the first open question: this section is what makes the rest of the report trustworthy, " +
        "so read the rest as unconfirmed until somebody has looked.",
      "  ",
    ));
  } else if (input.questions.length === 0) {
    lines.push(...wrap(
      "Nothing was left undecided, and that was checked rather than assumed. Nothing in this repair needed " +
        "money spent, needed a password, published anything about a person, or touched the parts of the system " +
        "that do the grading — those four always stop and wait for you.",
      "  ",
    ));
  } else {
    lines.push(...wrap(
      `${String(input.questions.length)} thing${input.questions.length === 1 ? "" : "s"} need${input.questions.length === 1 ? "s" : ""} a decision from you. ` +
        "Nothing was guessed in their place.",
      "  ",
    ));
    let n = 0;
    for (const question of input.questions) {
      n += 1;
      lines.push("");
      // A hanging indent, so the second line of a question sits under its text
      // and not under its number. The owner reads this on a phone.
      lines.push(...wrap(`${String(n)}. ${question.question}`, "     ", "  "));
      lines.push(...wrap(`Why I may not decide it: ${question.why}`, "     "));
      lines.push(...wrap(`What happened in the meantime: ${question.meanwhile}`, "     "));
      lines.push(...wrap(`Where this came from: ${question.source} (reference ${question.id})`, "     "));
    }
  }

  if (input.glossary.length > 0) {
    lines.push(...heading("A FEW WORDS THIS REPORT USES"));
    for (const entry of input.glossary) {
      lines.push(...wrap(`${entry.term} — ${entry.meaning}`, "  "));
    }
  }

  lines.push(...heading("WHERE THIS IS KEPT"));
  lines.push(...wrap(input.recordNote ?? "This report is stored with the dashboard's other results.", "  "));
  if (input.mailNote !== null) lines.push(...wrap(input.mailNote, "  "));

  return sanitiseReportText(`${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`, secrets);
}

/* =========================================================================
 * Disk — the channel that must not depend on a mail server
 * ====================================================================== */

export interface RepairReportWrite {
  readonly ok: boolean;
  readonly path: string;
  readonly detail: string;
}

/** `<results>/repair-reports/2026-08-16T09-14-02-000Z-ad220a03e411.txt`. */
export function repairReportPath(resultsDir: string, at: string, signature: string | null): string {
  const stamp = safeSegment(at.replace(/[:.]/g, "-"));
  const sig = signature === null || signature.trim() === "" ? "unattributed" : safeSegment(signature.slice(0, 16));
  return join(resultsDir, REPAIR_REPORT_DIRNAME, `${stamp}-${sig}.txt`);
}

/**
 * Write the report, and RETURN a write failure instead of throwing it.
 *
 * THE SAME RULE AS `repair-author.ts:849` (`appendAuthorJournal`), for the same
 * reason it gives: *"A refusal that vanished because its record could not be
 * written is indistinguishable from an attempt that never happened."* Mail is
 * required to fail open; a full disk must not be allowed to kill a repair
 * either, so the failure travels back as a value the caller can report.
 */
export function writeRepairReport(resultsDir: string, input: RepairReportInput, text: string): RepairReportWrite {
  const path = repairReportPath(resultsDir, input.at, input.signature);
  try {
    mkdirSync(join(resultsDir, REPAIR_REPORT_DIRNAME), { recursive: true });
    /*
     * WRITE-THEN-RENAME, BECAUSE THIS FUNCTION IS CALLED TWICE ON ONE PATH.
     *
     * Corrected 2026-08-16 from a debugfix finding, against a defect introduced
     * the same day by the fix that made the report truthful about delivery.
     * `deliverRepairReport` now writes once BEFORE the send and again after it,
     * so the second call overwrites a file that is already good. A bare
     * `writeFileSync` TRUNCATES FIRST: a failure between the truncate and the
     * write — a full disk, a revoked permission, a crash — leaves an empty or
     * half-written file where a complete, truthful report used to be. The
     * repair still happened; its only durable record is now rubble.
     *
     * `rename` within one directory is atomic on every filesystem this runs on,
     * so the reader sees either the old complete file or the new complete file
     * and never a partial one. The temp file is best-effort cleaned; a leftover
     * `.tmp` is harmless and visible, which is the right failure direction.
     */
    const temp = `${path}.tmp`;
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
    return { ok: true, path, detail: `the report was written to ${path}` };
  } catch (error) {
    return {
      ok: false,
      path,
      detail: `the report could NOT be written to ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/* =========================================================================
 * Delivery
 * ====================================================================== */

export interface RepairDelivery {
  readonly reportPath: string | null;
  readonly written: boolean;
  readonly writeDetail: string;
  readonly mailed: boolean;
  /** One of `repair-mail.ts#SMTP_CODES`. Never blank. */
  readonly mailCode: string;
  readonly mailDetail: string;
  /** `smtp://host:port (…)` — never the URL, because the URL has the password in it. */
  readonly mailTarget: string | null;
  /** The sidecar recording all of the above, or null if it could not be written. */
  readonly recordPath: string | null;
}

export interface DeliverRepairReportDeps {
  /** The dashboard's results root — `DashboardPaths.results`. */
  readonly resultsDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Injected so no test needs a mail server. Defaults to the real SMTP client. */
  readonly send?: (request: RepairMailRequest) => Promise<RepairMailResult>;
  /** Outer bound on the mail attempt, independent of the SMTP client's own clock. */
  readonly mailTimeoutMs?: number;
}

/**
 * Longer than `SMTP_TIMEOUT_MS` (20s) ON PURPOSE.
 *
 * This is the bound on a mailer that ignores its OWN clock — an injected seam
 * with no socket, a send that resolves never. If it were equal or shorter it
 * would fire first on every slow-but-working server and report a timeout for a
 * message that was actually delivered, which is the worse error: the owner would
 * chase a mail problem that does not exist while the real repair record sits on
 * disk unread.
 */
export const MAIL_DEADLINE_MS = 30_000;

/**
 * Write the report to disk, then TRY to email it.
 *
 * ─── THE ORDER IS THE POLICY ───
 *
 * Disk first, always, and the email is a best effort over a record that already
 * exists. The owner settled this on 2026-08-16: *"ALWAYS write the report to
 * disk under the dashboard's results root, so a mail outage never loses a
 * repair record."*
 *
 * ─── FAIL OPEN, AND WHERE THE GUARD LIVES ───
 *
 * `sendRepairMail` is written never to throw; the try/catch here is the guard
 * against that contract being broken — by a future edit, by an injected seam, by
 * a rejected promise nobody expected. Both guards are load-bearing and each has
 * its own mutation: delete the one in `repair-mail.ts` and its test goes red;
 * delete this one and `repair-report.test.ts`'s *"a mailer that throws does not
 * take the repair with it"* goes red. Neither covers for the other, which is the
 * point.
 *
 * ─── THE ONE THING A CRASH CAN STILL LOSE, NAMED ───
 *
 * The `.txt` is written before the send and the `.json` sidecar after it, so a
 * process killed mid-send leaves the report WITHOUT its delivery record. That is
 * the deliberate direction: the report is the thing worth keeping, and a missing
 * sidecar is visibly missing, whereas a sidecar written in advance would claim
 * an outcome that never happened.
 */
export async function deliverRepairReport(input: RepairReportInput, deps: DeliverRepairReportDeps): Promise<RepairDelivery> {
  const config = resolveRepairMailConfig(deps.env);
  /*
   * THE CONFIGURED CREDENTIAL, HANDED TO THE RENDERER SO IT CAN REDACT IT.
   * This is the only place in the program that legitimately holds the decoded
   * password, and the only way a report that quotes it in prose — rather than
   * inside a URL, where the pattern would catch it — can be scrubbed. See
   * `sanitiseReportText`'s docblock for why a pattern alone is not enough.
   */
  /*
   * THE PASSWORD ONLY. Corrected 2026-08-16 from a debugfix finding.
   *
   * The username was in this list too, and `scrubUrlCredentials` replaces EVERY
   * occurrence of any string of four characters or more. On the documented Gmail
   * configuration the username IS the owner's own email address and equals
   * `REPAIR_MAIL_TO` — so the report redacted the address it was telling the
   * owner it had been sent to, and every other appearance of it, producing a
   * corrupted document to protect something that is not a secret.
   *
   * It bought nothing either way: `describeSmtpTarget` excludes the username by
   * construction, so it never reaches the rendered text. `repair-mail.ts:104-109`
   * already rules that an address is not a credential; this list now agrees.
   */
  const secrets = [config.target?.password ?? ""].filter((value) => value !== "");

  /*
   * THE FIRST WRITE MUST NOT CLAIM THE EMAIL WAS SENT, BECAUSE IT HAS NOT BEEN.
   * Corrected 2026-08-16 after an adversarial review.
   *
   * This used to render ONCE with `mailNote: config.why`, whose text is
   * "This report was also emailed to <to> through <target>." — set
   * unconditionally by `resolveRepairMailConfig` whenever SMTP is configured —
   * write the file, and only then attempt the send. Nothing rewrote the file
   * afterwards, so a send that threw, timed out or was refused left a report on
   * disk asserting in the PAST TENSE that it had been delivered. The one
   * artefact whose job is to be trustworthy when nobody is watching was the one
   * lying about its own delivery.
   *
   * WRITE FIRST, THEN SEND, THEN REWRITE. The order is load-bearing in both
   * directions: writing first means a crash mid-send still leaves the report on
   * disk (its whole reason for existing is that mail is unreliable), and
   * rewriting after means the note states what actually happened. The
   * intermediate file says delivery is being ATTEMPTED, which is true at the
   * moment it is written and remains true if the process never gets further.
   */
  const attemptNote =
    input.mailNote ??
    (config.configured
      ? `Delivery of this report to ${config.to} was being attempted when this file was written. ` +
        `The .delivery.json sidecar beside it records what actually happened.`
      : config.why);
  const write = writeRepairReport(deps.resultsDir, input, renderRepairReport({ ...input, mailNote: attemptNote }, secrets));
  let text = renderRepairReport({ ...input, mailNote: attemptNote }, secrets);
  /** Non-null when the corrective second write failed. Folded into the record. */
  let rewriteDetail: string | null = null;

  /*
   * IF THE REPORT DID NOT REACH DISK, DO NOT SEND AN EMAIL DESCRIBING IT.
   * Corrected 2026-08-16. The mail went out regardless, and its body tells the
   * owner where the stored report and the `.delivery.json` sidecar are — neither
   * of which exists when the write failed. An email that sends the reader to two
   * files that are not there is worse than no email: it reads as a successful
   * repair with a filing problem, when in fact the only durable record is gone.
   */
  let mail: RepairMailResult;
  if (!write.ok) {
    mail = {
      ok: false,
      code: SMTP_CODES.notConfigured,
      detail:
        `the report could not be written to disk, so no email was sent — it would have pointed at a stored ` +
        `report and a delivery record that do not exist. ${write.detail}`,
      target: null,
    };
  } else if (!config.configured) {
    mail = { ok: false, code: SMTP_CODES.notConfigured, detail: config.why, target: null };
  } else {
    const send = deps.send ?? ((request: RepairMailRequest): Promise<RepairMailResult> => sendRepairMail(request, { env: deps.env }));
    try {
      mail = await withMailDeadline(
        send({ subject: repairReportSubject(input, secrets), body: text }),
        deps.mailTimeoutMs ?? MAIL_DEADLINE_MS,
      );
    } catch (error) {
      mail = {
        ok: false,
        code: SMTP_CODES.unexpected,
        detail: scrubUrlCredentials(
          `the email was abandoned because the mailer failed: ${error instanceof Error ? error.message : String(error)}. ` +
            "The report itself is unaffected — it is on disk either way.",
          // The thrown message came from a mailer holding the credential.
          secrets,
        ),
        target: config.target === null ? null : describeSmtpTarget(config.target),
      };
    }
  }

  /*
   * THE SECOND WRITE, CARRYING WHAT ACTUALLY HAPPENED. Best effort by design: if
   * it fails, the first write is still on disk and still truthful, because it
   * only ever claimed an attempt was under way. A failure here can therefore
   * never turn a truthful file into a false one — which is the property the
   * original single-write design did not have.
   */
  /*
   * `?? null`, NOT `=== undefined`. `RepairReportInput.mailNote` is
   * `string | null` and is never `undefined`, so the strict check this guard
   * first used was dead and the second write never fired — caught by the
   * pre-existing credential test, which is the only reason it is not still dead.
   */
  /*
   * `write.ok` ONLY — the caller's note no longer disables the rewrite.
   * Corrected 2026-08-16: the guard also required `input.mailNote === null`, so
   * any caller that supplied its own note silently restored the defect this
   * block exists to remove, and the report went to disk asserting a delivery
   * that had not happened. A support parameter must not be able to switch off a
   * correctness property. A caller-supplied note is honoured for the FIRST write
   * and replaced by the settled one, which is what a note about delivery should
   * be once delivery has actually been attempted.
   */
  if (write.ok) {
    const settledNote = config.configured
      ? mail.ok
        ? `This report was also emailed to ${config.to} through ${mail.target ?? "the configured server"}.`
        : `Delivery to ${config.to} was attempted and FAILED (${mail.code}): ${mail.detail} ` +
          `This file is the record; nothing was lost.`
      : config.why;
    text = renderRepairReport({ ...input, mailNote: settledNote }, secrets);
    /*
     * THE SECOND WRITE'S RESULT IS KEPT, NOT DISCARDED.
     *
     * Corrected 2026-08-16 from a debugfix finding, against this very block as
     * it was first written. The return value was dropped on the floor, so the
     * delivery record below reported `reportWritten: write.ok` — the FIRST
     * write's outcome — and a failed rewrite produced a sidecar claiming the
     * report was written successfully while the file on disk said delivery was
     * still being attempted. That is the same past-tense lie this block exists
     * to remove, moved one file sideways into the record that is supposed to
     * adjudicate it.
     *
     * The write is atomic (see `writeRepairReport`), so a failure here leaves
     * the FIRST report intact — which is why `settled.ok === false` degrades to
     * "the note is stale" rather than "the report is gone", and why the detail
     * says so.
     */
    const settled = writeRepairReport(deps.resultsDir, input, text);
    if (!settled.ok) {
      rewriteDetail =
        `the report was written, but could not be updated with the delivery outcome, so its closing note ` +
        `still says delivery was being attempted: ${settled.detail}`;
    }
  }

  const record = writeDeliveryRecord(write.path, secrets, {
    at: input.at,
    runId: input.runId,
    signature: input.signature,
    outcome: input.outcome,
    ownerQuestions: input.questionsAvailable ? input.questions.length : null,
    reportWritten: write.ok,
    reportDetail: rewriteDetail === null ? write.detail : `${write.detail}. ${rewriteDetail}`,
    /*
     * A SEPARATE FIELD, NOT A FLIPPED `reportWritten`. The report IS on disk —
     * the first write succeeded and the second is atomic — so saying it was not
     * written would be a different lie. What failed is the update, and the
     * reader needs to know the closing note is stale.
     */
    reportNoteStale: rewriteDetail !== null,
    mailed: mail.ok,
    mailCode: mail.code,
    mailDetail: mail.detail,
    /*
     * `describeSmtpTarget`'s output, or nothing. THE URL NEVER APPEARS HERE and
     * that is the whole reason this field is a string built elsewhere rather
     * than the configured value: the sidecar is a file on disk that outlives the
     * process, and `REPAIR_SMTP_URL` carries a password in its userinfo.
     */
    mailTarget: mail.target,
  });

  return {
    reportPath: write.ok ? write.path : null,
    written: write.ok,
    writeDetail: rewriteDetail === null ? write.detail : `${write.detail}. ${rewriteDetail}`,
    mailed: mail.ok,
    mailCode: mail.code,
    mailDetail: mail.detail,
    mailTarget: mail.target,
    recordPath: record,
  };
}

/** The delivery sidecar beside the report. Best effort; never throws. */
function writeDeliveryRecord(reportPath: string, secrets: readonly string[], record: Record<string, unknown>): string | null {
  const path = reportPath.replace(/\.txt$/, "") + ".delivery.json";
  try {
    writeFileSync(path, `${scrubUrlCredentials(JSON.stringify(record, null, 2), secrets)}\n`, "utf8");
    return path;
  } catch {
    return null;
  }
}

/**
 * Bound the mail attempt. RESOLVES with a named result rather than rejecting,
 * because a timeout is an ordinary delivery outcome and not an error.
 */
async function withMailDeadline(work: Promise<RepairMailResult>, timeoutMs: number): Promise<RepairMailResult> {
  let timer: NodeJS.Timeout | null = null;
  const guard = new Promise<RepairMailResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        code: SMTP_CODES.timedOut,
        detail: `the mail server did not finish within ${String(Math.round(timeoutMs / 1_000))} seconds, so the email was abandoned. The report is on disk.`,
        target: null,
      });
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
