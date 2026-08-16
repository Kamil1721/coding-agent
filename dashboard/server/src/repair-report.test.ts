/**
 * THE REPAIR REPORT, TESTED FROM THE SIDE THAT MAKES IT TRUSTWORTHY.
 *
 * Half of this file is about the report SUCCEEDING at describing a repair. The
 * other half — the half that exists because this repository has shipped a
 * check that could only observe success seventeen times — is about the report
 * being unable to hide anything:
 *
 *   - the OWNER half is present whether or not there is anything in it, and its
 *     three states are distinguishable;
 *   - a proof missing one of its three legs is reported as NOT PROVED;
 *   - a suite that never ran is never counted as a suite that passed;
 *   - a credential, a stack trace or a path naming a person cannot reach the
 *     rendered text, whichever field it arrives in;
 *   - the report is on disk even when the mailer explodes, and the call that
 *     wrote it does not throw.
 *
 * NO CREDENTIAL IS COMMITTED HERE. Every secret is `randomUUID()` at run time.
 * NO TEST TOUCHES A NETWORK: the mail seam is injected everywhere.
 *
 * Each mutation recorded below was applied to the source, compiled, run, its
 * failures read off the runner's output, reverted, and the revert proved
 * byte-exact with sha256 — never with `git diff`, which proves nothing about a
 * file git is not tracking. Where a mutation went red for a DIFFERENT reason
 * than it looks like it should have, the docblock says which assertion caught
 * it (see the delivery-record test).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REPAIR_MAIL_ENV, SMTP_CODES, SMTP_TIMEOUT_MS } from "./repair-mail.js";
import type { RepairMailResult } from "./repair-mail.js";
import {
  MAIL_DEADLINE_MS,
  REPAIR_REPORT_DIRNAME,
  deliverRepairReport,
  humanInstant,
  proofHolds,
  renderRepairReport,
  repairIsProved,
  repairReportPath,
  repairReportSubject,
  sanitiseReportText,
  scrubHostPaths,
  stripStackFrames,
  tallySuites,
  writeRepairReport,
} from "./repair-report.js";
import type { OwnerQuestion, RepairReportInput } from "./repair-report.js";

const AT = "2026-08-16T09:14:02.000Z";
const SIGNATURE = "ad220a03e411c0ffee0123456789abcdef0123456789abcdef0123456789abcd";

/**
 * A repair that went well and left nothing for the owner. Every test starts
 * from the HAPPIEST case and spoils exactly one thing, so a failed assertion
 * names the thing that was spoiled.
 */
function goodReport(overrides: Partial<RepairReportInput> = {}): RepairReportInput {
  return {
    at: AT,
    runId: "run-2026-08-16T07-34-18-997Z-d143e52d",
    ticketKey: "ticket-7",
    signature: SIGNATURE,
    outcome: "applied",
    headline: "A price lookup was crashing every run that used a model with no price on file. It is fixed.",
    whatBroke:
      "When a job finished, the dashboard tried to work out what it had cost. For one of the models there was " +
      "no price on file, and instead of saying so the program stopped with an error and took the whole job with it.",
    glossary: [{ term: "a run", meaning: "one job the dashboard does from start to finish" }],
    changes: [{ path: "dashboard/server/src/recovery.ts", what: "It now records that the price is unknown and carries on, instead of stopping." }],
    proof: {
      failedFirst: { state: "observed", note: "The old code stopped with the same error, on purpose, before anything was changed." },
      fixedAfter: { state: "observed", note: "With the change in place the same job finished and recorded an unknown price." },
      brokeAgainWhenUndone: { state: "observed", note: "Undoing just that change brought the error straight back." },
      transcriptsAt: "results/repair-proofs/ad220a03e411",
    },
    suites: [
      { name: "the dashboard server's tests", state: "green", detail: "412 tests, no failures" },
      { name: "the grading harness's tests", state: "green", detail: "188 tests, no failures" },
    ],
    questions: [],
    questionsAvailable: true,
    questionsUnavailableReason: null,
    recordNote: "This report is in the dashboard's results folder.",
    mailNote: null,
    ...overrides,
  };
}

const QUESTION: OwnerQuestion = {
  id: "SELF-PROPOSE",
  question: "May I change the part of the system that decides whether my own work is good enough?",
  why: "The fix I found is inside the grading code. Letting the system change its own marking is the one thing it is never allowed to do on its own.",
  source: "the gate parked the patch rather than applying it",
  meanwhile: "Nothing was changed. The fault is still there and the job will keep failing the same way until you decide.",
};

/**
 * The report folded to 78 columns, flattened back to one line.
 *
 * ASSERTING ON WRAPPED PROSE OTHERWISE MEASURES THE WRAPPER. A sentence that
 * straddles a line break does not match its own regex, so a test written
 * against the raw text would go red for a reformat and green for a deletion
 * that happened to leave the phrase on one line. Structural assertions
 * (headings, the `[YES]` markers, the tally line) still read the raw text,
 * where the line breaks are part of what is being checked.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function tempResults(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "repair-report-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/* =========================================================================
 * 1. WHAT IT DID
 * ====================================================================== */

test("the first half says what broke, what changed and how it was proved", () => {
  const text = renderRepairReport(goodReport());
  assert.match(text, /1\. WHAT WENT WRONG/);
  assert.match(flat(text), /no price on file/);
  assert.match(text, /2\. WHAT I CHANGED/);
  assert.match(text, /dashboard\/server\/src\/recovery\.ts/);
  assert.match(text, /3\. HOW I KNOW IT WORKS/);
  assert.match(text, /\[YES\] I made the fault happen on purpose/);
  assert.match(text, /\[YES\] With the change undone again/);
  assert.match(flat(text), /All three checks held and every test suite came back green/);
  assert.equal(text.includes("NOT proved"), false);
  assert.match(text, /Test suites: 2 of 2 green/);
  assert.equal(text.includes("ad220a03e411c0ffee"), false, "the whole 64-character signature is filename material, not prose");
});

/**
 * MUTATION RUN: `tallySuites`'s green filter changed to `s.state !== "red"`, so a
 * suite that never ran counts as green. RED, one test, this one, failing first
 * on the `deepEqual` below ("Expected values to be strictly deep-equal"): the
 * tally answered 2 green of 3 while still printing the "Never run" sentence
 * underneath it, which is the exact shape of a report that reads better than
 * the truth.
 */
test("a suite that never ran is never counted as a suite that passed", () => {
  const input = goodReport({
    suites: [
      { name: "the dashboard server's tests", state: "green", detail: "412 tests, no failures" },
      { name: "the browser tests", state: "not-run", detail: "no browser was available on this machine" },
      { name: "the grading harness's tests", state: "red", detail: "2 failures" },
    ],
  });
  assert.deepEqual(tallySuites(input.suites), {
    green: 1,
    total: 3,
    red: ["the grading harness's tests"],
    notRun: ["the browser tests"],
  });
  const text = renderRepairReport(input);
  assert.match(text, /Test suites: 1 of 3 green/);
  assert.match(flat(text), /Still failing: the grading harness's tests/);
  assert.match(flat(text), /Never run, so nothing is known about them either way: the browser tests/);
});

/**
 * MUTATION RUN: `proofHolds` changed to return true when the first two legs
 * hold (`brokeAgainWhenUndone` dropped from the conjunction). RED, one test,
 * this one, on the first assertion below — the report would have printed "All
 * three held" over a proof whose third leg says NOT CHECKED.
 *
 * This is design §5.3's rule rendered: *"A patch whose bundle is missing any of
 * the three transcripts is refused by the queue. Absence is treated exactly
 * like failure."*
 */
test("a two-legged proof is reported as NOT PROVED, not as a success with a footnote", () => {
  const input = goodReport({
    proof: {
      failedFirst: { state: "observed", note: "the fault was watched happening first" },
      fixedAfter: { state: "observed", note: "and it stopped" },
      brokeAgainWhenUndone: { state: "not-run", note: "the check was never run with the change undone" },
      transcriptsAt: null,
    },
  });
  assert.equal(proofHolds(input.proof), false);
  const text = renderRepairReport(input);
  assert.match(flat(text), /NOT ALL THREE CHECKS HELD, so this repair is NOT proved/);
  assert.equal(text.includes("every test suite came back green"), false);
  assert.match(text, /\[NOT CHECKED\] With the change undone again/);
});

/**
 * THE BRIEF'S PROOF HAS FOUR PARTS AND `proofHolds` KNOWS ABOUT THREE.
 *
 * *"reproduction went red, patch made it green, reverting made it red again,
 * all four suites green"* — so three green legs over a red suite is not a
 * proof, and saying so in the same section is the failure this whole document
 * is about.
 *
 * MUTATION RUN: the suite terms folded out of `repairIsProved`, leaving
 * `return proofHolds(proof)`. RED, one test, this one, on *"three green legs
 * over a red suite is not a proof"* — the report printed "All three checks held
 * and every test suite came back green" with a RED suite listed six lines
 * above it.
 */
test("three green legs over a red or unrun suite is reported as NOT proved end to end", () => {
  const red = goodReport({
    suites: [
      { name: "the dashboard server's tests", state: "green", detail: "412 tests, no failures" },
      { name: "the grading harness's tests", state: "red", detail: "2 failures" },
    ],
  });
  assert.equal(proofHolds(red.proof), true, "the three legs really did hold");
  assert.equal(repairIsProved(red.proof, red.suites), false, "three green legs over a red suite is not a proof");
  const text = renderRepairReport(red);
  assert.match(flat(text), /All three checks held, BUT the test suites above are not all green/);
  assert.match(flat(text), /this repair is NOT proved end to end/);
  assert.equal(text.includes("nothing else broke on the way"), false);

  // The same rule for a suite nobody ran, which is the arm that would otherwise
  // be satisfied by simply not running anything.
  const unrun = goodReport({ suites: [{ name: "the browser tests", state: "not-run", detail: "no browser here" }] });
  assert.equal(repairIsProved(unrun.proof, unrun.suites), false);
  assert.match(flat(renderRepairReport(unrun)), /NOT proved end to end/);

  // And no suites at all is not "nothing was red".
  assert.equal(repairIsProved(goodReport().proof, []), false, "an empty tally has nothing red in it and proves nothing");
  assert.match(flat(renderRepairReport(goodReport({ suites: [] }))), /no test suite was run at all/);
});

/* =========================================================================
 * 2. WHAT IT COULD NOT DECIDE — the half that makes the rest trustworthy
 * ====================================================================== */

/**
 * MUTATION RUN: the `4. WHAT I COULD NOT DECIDE` heading and all three of its
 * branches disabled in `renderRepairReport`. RED, FIVE TESTS — this one, the
 * singular-count one, "with nothing undecided the section is still there", "a
 * list of open questions that could NOT be built…", and "the subject and body
 * handed to the mailer are the same bytes that reached the disk", the last of
 * which is what proves the owner half is in the EMAILED bytes and not only in
 * the rendered string. That blast radius is the intent: removing the owner half
 * cannot be done quietly.
 */
test("the OWNER half appears, with each question's wording, reason, fallback and origin", () => {
  const second: OwnerQuestion = {
    id: "budget_exceeded",
    question: "May I spend more of the monthly allowance to finish this job?",
    why: "Spending money is yours to authorise. The system never decides that for itself.",
    source: "the job stopped at the spending limit",
    meanwhile: "The job is paused where it stopped. Nothing further has been spent.",
  };
  const text = renderRepairReport(goodReport({ questions: [QUESTION, second] }));
  const one = flat(text);
  assert.match(text, /4\. WHAT I COULD NOT DECIDE — THIS PART IS FOR YOU/);
  assert.match(one, /2 things need a decision from you/);
  assert.match(one, /Nothing was guessed in their place/);
  for (const question of [QUESTION, second]) {
    assert.equal(one.includes(flat(question.question).trim()), true, `the question itself is missing: ${question.id}`);
    assert.equal(one.includes(flat(question.why).trim()), true, `the reason it may not be decided is missing: ${question.id}`);
    assert.equal(one.includes(flat(question.meanwhile).trim()), true, `what happened instead is missing: ${question.id}`);
    assert.equal(one.includes(flat(question.source).trim()), true, `where it came from is missing: ${question.id}`);
    assert.equal(one.includes(`reference ${question.id}`), true);
  }
  assert.match(one, /Why I may not decide it:/);
  assert.match(one, /What happened in the meantime:/);
});

test("one question is counted in the singular, because a report that cannot count is not read twice", () => {
  const text = renderRepairReport(goodReport({ questions: [QUESTION] }));
  assert.match(flat(text), /1 thing needs a decision from you/);
});

test("with nothing undecided the section is still there, and says so explicitly", () => {
  const text = renderRepairReport(goodReport({ questions: [], questionsAvailable: true }));
  assert.match(text, /4\. WHAT I COULD NOT DECIDE — THIS PART IS FOR YOU/);
  assert.match(flat(text), /Nothing was left undecided, and that was checked rather than assumed/);
  assert.equal(text.includes("I CANNOT TELL YOU"), false);
});

/**
 * MUTATION RUN: the `if (!input.questionsAvailable)` branch removed so an
 * uncompiled list falls through to the empty-list wording. RED, one test, this
 * one, on "The input did not match /I CANNOT TELL YOU WHAT WAS LEFT UNDECIDED/"
 * — the report claimed "Nothing was left undecided, and that was checked rather
 * than assumed" about a list nobody had built.
 *
 * This is `defect-record.ts:208`'s rule ("absence is not emptiness") applied to
 * prose. An empty list and an unbuilt list read identically to a human, and the
 * second one is the dangerous one because it is believed.
 */
test("a list of open questions that could NOT be built is never rendered as 'nothing to decide'", () => {
  const text = renderRepairReport(
    goodReport({
      questions: [],
      questionsAvailable: false,
      questionsUnavailableReason: "The gate's record could not be read, so I do not know what it parked.",
    }),
  );
  assert.match(flat(text), /I CANNOT TELL YOU WHAT WAS LEFT UNDECIDED/);
  assert.match(flat(text), /The gate's record could not be read/);
  assert.equal(text.includes("Nothing was left undecided"), false, "an unbuilt list must never read as an empty one");
  assert.match(flat(text), /read the rest as unconfirmed until somebody has looked/);
});

test("the subject line leads with the outcome and says how many things need the owner", () => {
  assert.match(repairReportSubject(goodReport({ questions: [QUESTION] })), /^The dashboard fixed itself, 1 for you - /);
  assert.match(repairReportSubject(goodReport({ outcome: "refused" })), /^The dashboard rejected its own fix - /);
  assert.match(repairReportSubject(goodReport({ outcome: "inconclusive" })), /^The dashboard could not fix itself - /);
  // eslint-disable-next-line no-control-regex
  assert.equal(/^[\x20-\x7E]+$/.test(repairReportSubject(goodReport())), true, "a subject line stays ASCII so no encoded word is needed");
});

/* =========================================================================
 * 3. What may never reach the text
 * ====================================================================== */

/**
 * MUTATION RUN: `scrubUrlCredentials` dropped from `sanitiseReportText`. RED,
 * THREE TESTS — this one (on "the percent-encoded form must be gone"), the bare
 * decoded one below it, and the one-sanitiser test. The secret arrives through
 * `whatBroke`, which is where a thrown error's own words land.
 */
test("a credential that arrives inside the failure text never reaches the report", () => {
  // Two shapes, because a password with a URL-reserved character travels
  // percent-encoded and one without it travels as itself.
  const reserved = `${randomUUID()}/${randomUUID()}`;
  const encoded = encodeURIComponent(reserved);
  const plain = randomUUID();
  const text = renderRepairReport(
    goodReport({
      whatBroke: `The job could not reach the mail server. The error was: connect ECONNREFUSED smtps://account:${encoded}@mail.example.com:465.`,
      changes: [{ path: "dashboard/server/src/repair-mail.ts", what: `The retry used smtp://account:${plain}@backup.example.com:587 and failed too.` }],
    }),
  );
  assert.equal(text.includes(encoded), false, "the percent-encoded form must be gone");
  assert.equal(text.includes(plain), false, "and so must a password that needed no encoding");
  assert.match(text, /smtps:\/\/\[redacted\]@mail\.example\.com:465/);
  assert.match(text, /smtp:\/\/\[redacted\]@backup\.example\.com:587/);
});

/**
 * THE ARM A PATTERN ALONE CANNOT COVER.
 *
 * `URL.password` decodes, so the value in use is not the value in the URL, and
 * a sentence that quotes the DECODED password bare — no scheme, no `@` — is
 * unrecognisable to any regex. The one component that legitimately knows the
 * value passes it down.
 *
 * MUTATION RUN: the `secrets` argument dropped from
 * `renderRepairReport(..., secrets)` in `deliverRepairReport`. RED, one test,
 * this one, on "the decoded password must not survive into the report".
 */
test("a bare, decoded credential quoted in prose is redacted on the path that knows the value", async (t) => {
  const results = tempResults(t);
  const raw = `${randomUUID()}/${randomUUID()}`;
  const delivery = await deliverRepairReport(
    goodReport({ whatBroke: `The mail sign-in failed. The password in use was ${raw} and it should not be printed.` }),
    {
      resultsDir: results,
      env: {
        [REPAIR_MAIL_ENV.smtpUrl]: `smtps://account:${encodeURIComponent(raw)}@mail.example.com:465`,
        [REPAIR_MAIL_ENV.mailTo]: "owner@example.com",
      },
      send: async () => ({ ok: true, code: SMTP_CODES.sent, detail: "accepted", target: "smtps://mail.example.com:465 (signing in)" }),
    },
  );
  const text = readFileSync(delivery.reportPath ?? "", "utf8");
  assert.equal(text.includes(raw), false, "the decoded password must not survive into the report");
  assert.match(flat(text), /The password in use was \[redacted\]/);
  assert.equal(readFileSync(delivery.recordPath ?? "", "utf8").includes(raw), false);
});

/**
 * MUTATION RUN: `stripStackFrames` dropped from `sanitiseReportText`. RED, one
 * test, this one, on "The input did not match /the technical trace is left out
 * here/": the three `at …:802:11` frames were rendered straight into the body of
 * an email written for somebody who is not at a terminal.
 */
test("a stack trace in the failure text is replaced by one honest sentence", () => {
  const text = renderRepairReport(
    goodReport({
      whatBroke:
        "The price lookup failed.\n" +
        "    at resolvePrice (/Users/someone/coding-agent/bakeoff/src/contracts.ts:802:11)\n" +
        "    at async priceVendorUsage (/Users/someone/coding-agent/bakeoff/src/ledger.ts:44:3)\n" +
        "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n" +
        "It happens on every job that uses that model.",
    }),
  );
  assert.equal(/^\s*at .+:\d+:\d+/m.test(text), false, "not one stack frame survives");
  assert.match(flat(text), /the technical trace is left out here/);
  assert.match(flat(text), /It happens on every job that uses that model/, "the sentences around the trace are kept");
  assert.equal(stripStackFrames("plain line\n").includes("technical trace"), false, "and a report with no trace gains no such note");
});

/**
 * MUTATION RUN: `scrubHostPaths` dropped from `sanitiseReportText`. RED, one
 * test, this one, on the `includes("/Users/")` assertion: the owner's home
 * directory, which carries his name, was rendered into an email.
 * Design §3.6 item 1 makes anything naming a person leaving this machine an
 * owner-only decision, and an email leaves this machine.
 */
test("an absolute host path is reduced to ~, because it names a person and this is an email", () => {
  const text = renderRepairReport(
    goodReport({
      recordNote: "The record is at /Users/kamilborzecki/Projects/coding-agent/dashboard/results/x.txt",
      changes: [{ path: "/Users/kamilborzecki/Projects/coding-agent/dashboard/server/src/recovery.ts", what: "one line" }],
    }),
  );
  assert.equal(text.includes("/Users/"), false);
  assert.equal(text.includes("kamilborzecki"), false);
  assert.match(text, /~\/Projects\/coding-agent\/dashboard\/results\/x\.txt/);
  assert.equal(scrubHostPaths("see file:///home/someone/a/b"), "see ~/a/b");
});

test("the whole document goes through one sanitiser, so a field added later is covered by construction", () => {
  const secret = randomUUID();
  assert.equal(sanitiseReportText(`x smtp://u:${secret}@h/y`).includes(secret), false);
  assert.equal(humanInstant(AT), "2026-08-16 at 09:14 UTC");
  assert.equal(humanInstant("not a date"), "at an unrecorded time");
});

/* =========================================================================
 * 4. Disk, which is the channel that must not depend on a mail server
 * ====================================================================== */

test("the report lands under the results root, named by time and signature", (t) => {
  const results = tempResults(t);
  const input = goodReport();
  const write = writeRepairReport(results, input, renderRepairReport(input));
  assert.equal(write.ok, true, write.detail);
  assert.equal(write.path, join(results, REPAIR_REPORT_DIRNAME, "2026-08-16T09-14-02-000Z-ad220a03e411c0ff.txt"));
  assert.match(readFileSync(write.path, "utf8"), /WHAT THE DASHBOARD DID WHILE YOU WERE AWAY/);
  assert.equal(repairReportPath(results, AT, null).endsWith("-unattributed.txt"), true, "a report with no signature is still written");
});

/**
 * MUTATION RUN: `throw error;` inserted at the head of `writeRepairReport`'s
 * catch. RED, one test, this one, with node's "Got unwanted exception." — on the
 * real path that throw leaves a repair's terminal transition. The rule is
 * `repair-author.ts:849`'s: a record that could not be written is a fact the
 * caller reports, not an exception it dies of.
 */
test("a results root that cannot be written to is reported, not thrown", (t) => {
  const results = tempResults(t);
  writeFileSync(join(results, REPAIR_REPORT_DIRNAME), "I am a file, not a directory\n", "utf8");
  const input = goodReport();
  let write: ReturnType<typeof writeRepairReport> | null = null;
  assert.doesNotThrow(() => { write = writeRepairReport(results, input, "text\n"); });
  assert.equal(write === null ? true : (write as { ok: boolean }).ok, false);
  assert.match(write === null ? "" : (write as { detail: string }).detail, /could NOT be written/);
});

/* =========================================================================
 * 5. Delivery — and the rule that mail may never kill a repair
 * ====================================================================== */

test("with no mail server configured the report is still written, and says that no email was sent", async (t) => {
  const results = tempResults(t);
  const delivery = await deliverRepairReport(goodReport(), { resultsDir: results, env: {} });
  assert.equal(delivery.written, true, delivery.writeDetail);
  assert.equal(delivery.mailed, false);
  assert.equal(delivery.mailCode, SMTP_CODES.notConfigured);
  const text = readFileSync(delivery.reportPath ?? "", "utf8");
  assert.match(flat(text), /No email was sent: no mail server is configured/);
  assert.match(flat(text), /only copy of this report/);
  const record = JSON.parse(readFileSync(delivery.recordPath ?? "", "utf8")) as Record<string, unknown>;
  assert.equal(record["mailed"], false);
  assert.equal(record["reportWritten"], true);
  assert.equal(record["ownerQuestions"], 0);
});

/**
 * THE OWNER'S RULE, 2026-08-16: a mailer that throws must never kill a repair.
 *
 * MUTATION RUN: `throw error;` inserted at the head of the catch around the
 * `send(...)` call in `deliverRepairReport`. RED, one test, this one, with
 * node's "Got unwanted rejection." — the mailer's throw propagated out of the
 * delivery call, which on the real path is a dead repair.
 *
 * THE FILE-EXISTS ASSERTION ALONE WOULD NOT HAVE CAUGHT IT, and that is the
 * point of asserting the returned value too: the `.txt` is written BEFORE the
 * send, so it is on disk under the mutant as well. A test that only checked the
 * file would have passed against the broken code — this repository's signature
 * defect, reproduced inside the test written to prevent it.
 */
test("a mailer that throws does not take the repair with it", async (t) => {
  const results = tempResults(t);
  const call = deliverRepairReport(goodReport({ questions: [QUESTION] }), {
    resultsDir: results,
    env: { [REPAIR_MAIL_ENV.smtpUrl]: "smtp://mail.example.com:587", [REPAIR_MAIL_ENV.mailTo]: "owner@example.com" },
    send: () => { throw new Error("the mail server exploded"); },
  });
  await assert.doesNotReject(call);
  const delivery = await call;
  assert.equal(delivery.mailed, false, "and it is reported as not mailed rather than assumed sent");
  assert.equal(delivery.mailCode, SMTP_CODES.unexpected);
  assert.match(delivery.mailDetail, /the mailer failed/);
  assert.equal(delivery.written, true);
  assert.equal(existsSync(delivery.reportPath ?? ""), true, "the repair record survived the outage");
  const record = JSON.parse(readFileSync(delivery.recordPath ?? "", "utf8")) as Record<string, unknown>;
  assert.equal(record["mailed"], false);
  assert.equal(record["ownerQuestions"], 1);
});

/**
 * THE TWO CLOCKS, PINNED BY READING BOTH CONSTANTS RATHER THAN BY BELIEVING A
 * DOCBLOCK.
 *
 * `MAIL_DEADLINE_MS` bounds a mailer that ignores its own clock; `SMTP_TIMEOUT_MS`
 * bounds the SMTP conversation. If the outer one were the shorter, it would fire
 * first on every slow-but-working server and report a timeout for a message that
 * was actually delivered — sending the owner after a mail fault that does not
 * exist while the real repair record sits unread on disk. Same shape as
 * `repair-author.test.ts`'s budget inequality, and for the same reason: closing
 * the gap should be a red test, not a silent overrun.
 */
test("the outer mail deadline is longer than the SMTP client's own", () => {
  assert.ok(
    MAIL_DEADLINE_MS > SMTP_TIMEOUT_MS,
    `MAIL_DEADLINE_MS (${String(MAIL_DEADLINE_MS)}) must exceed SMTP_TIMEOUT_MS (${String(SMTP_TIMEOUT_MS)})`,
  );
});

test("a mailer that never answers is abandoned on its own clock and the report still lands", async (t) => {
  const results = tempResults(t);
  const delivery = await deliverRepairReport(goodReport(), {
    resultsDir: results,
    env: { [REPAIR_MAIL_ENV.smtpUrl]: "smtp://mail.example.com:587", [REPAIR_MAIL_ENV.mailTo]: "owner@example.com" },
    send: async () =>
      new Promise<RepairMailResult>((resolve) => {
        const timer = setTimeout(() => { resolve({ ok: true, code: SMTP_CODES.sent, detail: "far too late", target: null }); }, 5_000);
        timer.unref();
      }),
    mailTimeoutMs: 100,
  });
  assert.equal(delivery.mailed, false);
  assert.equal(delivery.mailCode, SMTP_CODES.timedOut);
  assert.equal(delivery.written, true);
  assert.match(delivery.mailDetail, /The report is on disk/);
});

/**
 * THE LANE BRIEF'S MUTATION — "interpolate the SMTP URL" — RUN TWICE, BECAUSE
 * THE FIRST RUN DID NOT FAIL FOR THE REASON IT LOOKED LIKE IT FAILED FOR.
 *
 *   M16a `mailTarget: mail.target` → `mailTarget: deps.env["REPAIR_SMTP_URL"]`.
 *        **RED**, this test, on *"but it must still say where the mail went"* —
 *        NOT on a leak. `writeDeliveryRecord` still ran the sidecar through
 *        `scrubUrlCredentials`, so the password came out `[redacted]` and the
 *        record no longer named the server. The scrubber held; the assertion
 *        that caught the mutation was the one insisting the record stays
 *        USEFUL. Recorded precisely because "it went red" would have implied a
 *        leak this arm did not actually demonstrate.
 *   M16b the same edit PLUS dropping the sidecar's `scrubUrlCredentials`.
 *        **RED** on *"the delivery record must not carry the password"* — the
 *        leak assertion, firing on a real leak.
 *
 * The pair is the honest statement of what protects this file: two independent
 * things, and the test can tell them apart.
 */
test("neither the report nor the delivery record ever carries the SMTP credential", async (t) => {
  const results = tempResults(t);
  const password = randomUUID();
  const delivery = await deliverRepairReport(goodReport(), {
    resultsDir: results,
    env: {
      [REPAIR_MAIL_ENV.smtpUrl]: `smtps://account:${password}@mail.example.com:465`,
      [REPAIR_MAIL_ENV.mailTo]: "owner@example.com",
    },
    send: async () => ({ ok: true, code: SMTP_CODES.sent, detail: "the mail server accepted the message (250 Ok)", target: "smtps://mail.example.com:465 (signing in)" }),
  });
  assert.equal(delivery.mailed, true);
  const text = readFileSync(delivery.reportPath ?? "", "utf8");
  const record = readFileSync(delivery.recordPath ?? "", "utf8");
  for (const [where, content] of [["the report", text], ["the delivery record", record]] as const) {
    assert.equal(content.includes(password), false, `${where} must not carry the password`);
    assert.equal(content.includes("account:"), false, `${where} must not carry the account either`);
  }
  assert.match(record, /smtps:\/\/mail\.example\.com:465/, "but it must still say where the mail went");
  assert.match(flat(text), /This report was also emailed to owner@example.com/);
  assert.equal(JSON.stringify(delivery).includes(password), false);
});

test("the subject and body handed to the mailer are the same bytes that reached the disk", async (t) => {
  const results = tempResults(t);
  const seen: { subject: string; body: string }[] = [];
  const delivery = await deliverRepairReport(goodReport({ questions: [QUESTION] }), {
    resultsDir: results,
    env: { [REPAIR_MAIL_ENV.smtpUrl]: "smtp://mail.example.com:587", [REPAIR_MAIL_ENV.mailTo]: "owner@example.com" },
    send: async (request) => {
      seen.push({ subject: request.subject, body: request.body });
      return { ok: true, code: SMTP_CODES.sent, detail: "accepted", target: "smtp://mail.example.com:587 (no sign-in)" };
    },
  });
  assert.equal(seen.length, 1);
  /*
   * THE BODY AND THE FILE AGREE ON EVERYTHING EXCEPT THE DELIVERY NOTE, and that
   * one difference is required rather than tolerated.
   *
   * Corrected 2026-08-16. This used to assert byte equality, which was only true
   * because the report was rendered ONCE, before the send, with a note claiming
   * in the past tense that it had been emailed — so a send that threw left a
   * file on disk asserting its own successful delivery. The file is now
   * rewritten with what actually happened, and an email plainly cannot contain
   * the outcome of its own delivery. Byte equality and a truthful file are
   * mutually exclusive; the file wins.
   *
   * The property worth keeping is that the READER of either artefact sees the
   * same repair, so everything above the delivery note must still match exactly.
   */
  const upTo = (text: string): string => text.split("WHERE THIS IS KEPT")[0] ?? "";
  const onDisk = readFileSync(delivery.reportPath ?? "", "utf8");
  assert.equal(upTo(seen[0]?.body ?? ""), upTo(onDisk), "the emailed repair and the filed repair must be the same repair");
  assert.notEqual(seen[0]?.body, onDisk, "and they must differ, because only the file can know whether the mail arrived");
  assert.match(flat(onDisk), /This report was also emailed to owner@example\.com/);
  assert.doesNotMatch(
    flat(seen[0]?.body ?? ""),
    /was also emailed to/,
    "the email itself must not claim it was delivered — it has not been, at the moment it is composed",
  );
  assert.match(seen[0]?.subject ?? "", /1 for you/);
  assert.match(seen[0]?.body ?? "", /4\. WHAT I COULD NOT DECIDE/);
});

/* =========================================================================
 * A REPORT MUST NOT CLAIM A DELIVERY THAT DID NOT HAPPEN
 *
 * Added 2026-08-16 after an adversarial review. The module rendered ONCE, before
 * the send, with `mailNote: config.why` — a string `resolveRepairMailConfig`
 * sets unconditionally to "This report was also emailed to <to>…" whenever SMTP
 * is configured — wrote the file, and only then attempted delivery. Nothing
 * rewrote it afterwards.
 *
 * So a send that threw, timed out or was refused left, on disk, a report
 * asserting IN THE PAST TENSE that it had been emailed. The one artefact whose
 * entire purpose is to be trustworthy when nobody is watching was lying about
 * the one thing the reader cannot verify for themselves.
 * ====================================================================== */

test("a FAILED send leaves a report that says so, not one that claims success", async (t) => {
  const results = tempResults(t);
  const delivery = await deliverRepairReport(goodReport(), {
    resultsDir: results,
    env: {
      [REPAIR_MAIL_ENV.smtpUrl]: "smtps://account:hunter2hunter2@mail.example.com:465",
      [REPAIR_MAIL_ENV.mailTo]: "owner@example.com",
    },
    send: async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:465");
    },
  });

  assert.equal(delivery.mailed, false, "the fixture must actually fail, or this test measures nothing");
  const text = flat(readFileSync(delivery.reportPath ?? "", "utf8"));

  /*
   * MUTATION: delete the second `writeRepairReport` in `deliverRepairReport`.
   * The file keeps the pre-send note and this goes RED on the first assertion —
   * which is the exact code state the review found.
   */
  assert.doesNotMatch(
    text,
    /was also emailed to/,
    "the send threw, so the report on disk must not assert in the past tense that it was delivered",
  );
  assert.match(text, /attempted and FAILED/, "and it must say plainly that delivery did not happen");
  assert.match(text, /nothing was lost/, "while making clear the repair itself is unaffected");

  // AND THE CREDENTIAL STILL DOES NOT SURVIVE THE FAILURE PATH, which is the
  // path most likely to quote a raw error string back into the document.
  assert.equal(text.includes("hunter2hunter2"), false, "a failed send must not leak the password it tried to use");
});

test("a credential with a SPACE in it cannot survive the line-folding", async (t) => {
  /*
   * THE BLOCKING LEAK, and it is not theoretical: a Gmail app-password is issued
   * and displayed as four space-separated groups, so this is the shape the owner
   * is most likely to configure.
   *
   * `wrap` folds prose to a column by splitting on /\s+/ and rejoining across
   * line breaks, and it runs BEFORE the only secrets-aware pass. A multi-word
   * secret is therefore already broken over a newline by the time
   * `scrubUrlCredentials` looks for it, so `split(secret)` finds nothing.
   *
   * MUTATION: remove the whitespace-insensitive second pass in
   * `scrubUrlCredentials` (repair-mail.ts) -> RED. The exact-match pass alone
   * leaves the folded credential in both artefacts.
   */
  const results = tempResults(t);
  const spaced = "abcd efgh ijkl mnop";
  /*
   * THE FILLER IS 69 CHARACTERS FOR A REASON, AND THE TEST ASSERTS THE REASON
   * BELOW. `wrap` folds at WIDTH = 78: with a 69-character first word, "abcd"
   * fits (69+4+1 = 74) and "efgh" does not (74+4+1 = 79), so the line break
   * lands INSIDE the credential. An earlier draft of this test put the whole
   * secret comfortably on one line, the exact-match pass caught it, and removing
   * the whitespace-insensitive pass left the suite GREEN — the test observed
   * nothing. Measured, then fixed.
   */
  const long = `${"A".repeat(69)} ${spaced} and then some trailing prose so the paragraph continues`;
  const delivery = await deliverRepairReport(goodReport({ headline: long }), {
    resultsDir: results,
    env: {
      [REPAIR_MAIL_ENV.smtpUrl]: `smtps://account:${encodeURIComponent(spaced)}@mail.example.com:465`,
      [REPAIR_MAIL_ENV.mailTo]: "owner@example.com",
    },
    send: async () => ({ ok: true, code: SMTP_CODES.sent, detail: "accepted", target: "smtps://mail.example.com:465 (signing in)" }),
  });

  const raw = readFileSync(delivery.reportPath ?? "", "utf8");

  /*
   * THE PRECONDITION, ASSERTED. Without this the test silently stops exercising
   * the folded path the day WIDTH changes or the headline moves, and goes on
   * passing forever.
   */
  const unredacted = renderRepairReport({ ...goodReport({ headline: long }), mailNote: null }, []);
  assert.ok(
    /abcd\s*\n/.test(unredacted),
    "this fixture no longer folds the credential across a line break, so it cannot observe the defect",
  );

  assert.equal(raw.includes(spaced), false, "the credential survived verbatim");
  assert.equal(
    flat(raw).includes(spaced),
    false,
    "the credential survived the fold: it is on disk broken across a line break, which no exact-match " +
      "redaction can see and which reassembles the moment anyone reads the file as prose",
  );
});

/**
 * THE REPORT DIRECTORY MUST BE THE ONE THE BUILDER IS DENIED.
 *
 * Added 2026-08-16 from a debugfix finding. Repair reports quote `TestFailure`
 * strings — held-out test titles, expected and actual values — and the scorer
 * protocol rules that those may live only inside a sealed root. The reports were
 * being written to `results/repair-reports/`, which was named in NO deny layer:
 * `sealedRoots` was `[acceptance, scorer-out, scores]`. That is the third
 * instance of one pattern, and `gate-attempts.ts` records the previous two.
 *
 * WHY A TEST RATHER THAN A COMMENT. This module receives `resultsDir` as a
 * string, so it cannot call `repairReportsRoot` without inverting its signature.
 * The two spellings are therefore bound HERE, which is the only place the drift
 * can be observed.
 *
 * MUTATION: change REPAIR_REPORT_DIRNAME to "reports" -> RED. Under the old code
 * that same edit was silent, and every report written afterwards would have sat
 * outside the deny while looking correct.
 */
test("the directory reports are written to is the directory builders are denied", async () => {
  const { repairReportsRoot } = await import("./gate-attempts.js");
  const results = "/tmp/dash-home/results";
  const denied = repairReportsRoot({ results } as never);
  const written = repairReportPath(results, "2026-08-16T09:14:02.000Z", "ad220a03e411");

  assert.ok(
    written.startsWith(`${denied}/`),
    `reports are written to ${written}, which is outside the denied root ${denied} — a builder on a later ` +
      "attempt of the same frozen ticket could read the assertions it is about to be graded against",
  );
});

/**
 * A FAILED SECOND WRITE MUST NOT PRODUCE A RECORD THAT CLAIMS SUCCESS, AND MUST
 * NOT DESTROY THE FIRST REPORT.
 *
 * Both defects were introduced on 2026-08-16 by the fix that made the report
 * truthful about delivery, and both were found the same day by a debugfix lens:
 *
 *   1. `writeRepairReport` used a bare `writeFileSync`, which TRUNCATES first.
 *      The second call overwrites a file that is already complete and truthful,
 *      so a failure mid-write left rubble where the only durable record of the
 *      repair used to be. Now it writes a temp file and renames.
 *   2. The second call's return value was discarded, so the sidecar reported the
 *      FIRST write's success while the file on disk still said delivery was
 *      being attempted — the same past-tense lie, moved into the record that is
 *      meant to adjudicate it.
 *
 * MUTATION 1: revert `writeRepairReport` to `writeFileSync(path, text)` -> the
 * "first report survives" assertion goes RED.
 * MUTATION 2: drop the `settled` capture and go back to `writeRepairReport(...)`
 * bare -> the `reportNoteStale` assertion goes RED.
 */
test("a failed rewrite keeps the first report and is admitted in the record", async (t) => {
  const results = tempResults(t);
  const input = goodReport();
  const path = repairReportPath(results, input.at, input.signature);

  /*
   * THE FIXTURE IS SURGICAL ON PURPOSE. An earlier draft made the whole report
   * DIRECTORY read-only, which also broke the delivery sidecar — so the test
   * failed on a null `recordPath` and measured the wrong thing. Blocking only
   * the rewrite's TEMP path fails exactly one operation: the second write's
   * `writeFileSync(temp)` hits EISDIR, the first report is never touched, and
   * the sidecar (a different filename) still lands so its claim can be read.
   */
  let calls = 0;
  const delivery = await deliverRepairReport(input, {
    resultsDir: results,
    env: { [REPAIR_MAIL_ENV.smtpUrl]: "smtp://mail.example.com:587", [REPAIR_MAIL_ENV.mailTo]: "owner@example.com" },
    send: async () => {
      calls += 1;
      mkdirSync(`${path}.tmp`, { recursive: true });
      return { ok: true, code: SMTP_CODES.sent, detail: "accepted", target: "smtp://mail.example.com:587 (no sign-in)" };
    },
  });

  assert.equal(calls, 1, "the fixture must actually have sent, or the second write never runs");
  assert.equal(delivery.written, true, `the FIRST write failed, so this measures nothing: ${delivery.writeDetail}`);

  /*
   * 1. THE FIRST REPORT SURVIVED — the assertion the atomic write exists for.
   *    MUTATION: revert `writeRepairReport` to a bare `writeFileSync(path, …)`
   *    -> the truncate happens before the failure and this goes RED.
   */
  const onDisk = readFileSync(delivery.reportPath ?? "", "utf8");
  assert.ok(onDisk.length > 0, "the failed rewrite destroyed the report it was updating");
  assert.match(flat(onDisk), /WHAT THE DASHBOARD DID WHILE YOU WERE AWAY/);

  /*
   * 2. AND THE RECORD ADMITS THE NOTE IS STALE instead of reporting the first
   *    write's success as if it were the second's.
   *    MUTATION: drop the `settled` capture -> `reportNoteStale` is absent
   *    and this goes RED.
   */
  const record = JSON.parse(readFileSync(delivery.recordPath ?? "", "utf8")) as Record<string, unknown>;
  assert.equal(record["reportNoteStale"], true, "the sidecar claimed a clean write that did not happen");
  assert.match(String(delivery.writeDetail), /could not be updated with the delivery outcome/);
});

/**
 * THREE DEFECTS A DEBUGFIX LENS FOUND IN THIS MODULE, each fixed and each
 * mutation named. All three shipped on 2026-08-16 in the same session that
 * wrote the module.
 */
test("the owner's own address is not treated as a credential and scrubbed out of the report", async (t) => {
  /*
   * `scrubUrlCredentials` replaces every occurrence of any secret four characters
   * or longer. The SMTP username was in that list, and on the documented Gmail
   * setup it IS the owner's address and equals REPAIR_MAIL_TO — so the report
   * redacted the address it was telling the owner it had been sent to.
   *
   * MUTATION: put `config.target?.username` back into `secrets` -> RED.
   */
  const results = tempResults(t);
  const delivery = await deliverRepairReport(goodReport(), {
    resultsDir: results,
    env: {
      [REPAIR_MAIL_ENV.smtpUrl]: "smtps://owner%40example.com:hunter2hunter2@smtp.example.com:465",
      [REPAIR_MAIL_ENV.mailTo]: "owner@example.com",
    },
    send: async () => ({ ok: true, code: SMTP_CODES.sent, detail: "accepted", target: "smtps://smtp.example.com:465 (signing in)" }),
  });
  const text = flat(readFileSync(delivery.reportPath ?? "", "utf8"));
  assert.match(text, /owner@example\.com/, "the report scrubbed the address it says it was emailed to");
  assert.equal(text.includes("hunter2hunter2"), false, "and the password must still be gone — the control");
});

test("a caller-supplied note cannot switch off the corrective second write", async (t) => {
  /*
   * The rewrite guard also required `input.mailNote === null`, so any caller
   * passing its own note restored the "report claims a delivery that never
   * happened" defect through a support parameter.
   *
   * MUTATION: restore `(input.mailNote ?? null) === null &&` to the guard -> RED.
   */
  const results = tempResults(t);
  const delivery = await deliverRepairReport(goodReport({ mailNote: "a note the caller supplied" }), {
    resultsDir: results,
    env: { [REPAIR_MAIL_ENV.smtpUrl]: "smtp://mail.example.com:587", [REPAIR_MAIL_ENV.mailTo]: "owner@example.com" },
    send: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  const text = flat(readFileSync(delivery.reportPath ?? "", "utf8"));
  assert.match(text, /attempted and FAILED/, "the settled outcome must replace the caller's note once delivery was tried");
  assert.doesNotMatch(text, /a note the caller supplied/);
});

test("no email is sent describing a report that never reached disk", async (t) => {
  /*
   * The mail went out regardless of the write, and its body directs the owner to
   * a stored report and a sidecar that do not exist.
   *
   * MUTATION: delete the `if (!write.ok)` arm -> the send fires and this goes RED.
   */
  const results = tempResults(t);
  // Block the write by putting a directory where the report file must go.
  const path = repairReportPath(results, goodReport().at, goodReport().signature);
  mkdirSync(path, { recursive: true });

  let sends = 0;
  const delivery = await deliverRepairReport(goodReport(), {
    resultsDir: results,
    env: { [REPAIR_MAIL_ENV.smtpUrl]: "smtp://mail.example.com:587", [REPAIR_MAIL_ENV.mailTo]: "owner@example.com" },
    send: async () => {
      sends += 1;
      return { ok: true, code: SMTP_CODES.sent, detail: "accepted", target: "t" };
    },
  });

  assert.equal(delivery.written, false, "the fixture must actually block the write, or this measures nothing");
  assert.equal(sends, 0, "an email was sent pointing at a report and a sidecar that do not exist");
  assert.match(delivery.mailDetail, /do not exist/);
});
