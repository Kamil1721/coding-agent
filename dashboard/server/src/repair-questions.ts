/**
 * repair-questions.ts — the QUESTION layer of the repair lane. Codex asks;
 * Claude answers from evidence; nothing here answers from anybody's priors.
 *
 * Implements `docs/DESIGN-repair-lane-2026-08-16.md` §10.3 (the evidence-source
 * guard), §10.5 (Codex is the ASKER, not the reviewer), §10.5.4 (the bound) and
 * §11 (the panel's data shape and its two metrics).
 *
 * MEASURED, SO NOBODY LOSES AN HOUR LOOKING: that design file is NOT committed
 * at HEAD `ea80328` — `git log --all -- docs/DESIGN-repair-lane-2026-08-16.md`
 * returns nothing and the path does not exist in a fresh worktree. It was read
 * from the owner's working checkout. Every § reference below is to that
 * uncommitted document; the committed `docs/DESIGN-self-maintaining-pipeline.md`
 * numbers its sections differently and §10.3 there is a DIFFERENT section.
 *
 * ─── WHY AN ASKER AND NOT A REVIEWER ───
 *
 * §10.5.1 records two defects shipped on 2026-08-16 — a reporter that read
 * `details.error` (the runner's wrapper, not the thrown error) and a message
 * fallback reached by nothing. Neither was a WRONG ANSWER; both were MISSING
 * QUESTIONS, and neither was caught by review. The end-to-end re-score of
 * `047f9872` passed with the reporter defect present. A reviewer looking at a
 * green end-to-end has nothing to object to; a questioner asking "how do you
 * know that field is the thrown error?" ends it in one line.
 *
 * So the independent model goes at the FRONT of the loop (§10.5.3):
 *
 *   defect record
 *         |
 *   CODEX  ask: "what must be known before anyone claims to understand this?"
 *         |     -> questions, each tagged CODE / DATA / EXPERIMENT / CODEX / OWNER
 *   CLAUDE answer each from its named source. Never from priors.
 *         |
 *         diagnosis -> patch
 *
 * ─── THE TWO RULES THIS FILE IS BUILT AROUND ───
 *
 * THE BOUND (§10.5.4). "Keep only questions whose surprising answer would CHANGE
 * the diagnosis." An unbounded asker produces forty questions and the lane
 * drowns. The filter is not a count: it is the repo's own
 * `probe-needs-negative-control` rule pointed at enquiry — a question that
 * cannot change the outcome observes nothing, exactly as a test that cannot go
 * red observes nothing. {@link boundQuestions} is that filter.
 *
 * THE GUARD (§10.3). "Every self-asked question must name its evidence source
 * BEFORE it is answered", and "a question that cannot be assigned one of the
 * first four IS the fifth". {@link resolveAnswer} is that rule, and it is
 * enforced in two layers: the TYPE forbids constructing an evidenced answer
 * without a citation ({@link AnsweredQuestion} has `citation: string`, not
 * `string | null`), and the VALIDATOR forbids a citation that is merely
 * non-empty ({@link citationProblem} checks the SHAPE §10.3's table names for
 * each source). Without the second layer `citation: "yes"` would pass and the
 * guard would be decorative — a check that can only observe success.
 *
 * ─── WHAT A `CODEX` CITATION IS, AND WHAT IT IS NOT ───
 *
 * §10.5.5: "Two models agreeing is still two models agreeing — it is not
 * evidence, and it never reaches the gate as if it were." A thread id alone
 * therefore does NOT satisfy the guard. `CODEX` is a ROUTE to evidence, not a
 * kind of evidence: a CODEX citation must carry the thread id for provenance
 * AND, after the separator, a citation that independently passes the CODE, DATA
 * or EXPERIMENT shape — the `file:line` Codex pointed at, or the command it ran.
 * {@link citationProblem} recurses to enforce exactly that.
 *
 * ─── WHAT THE BOUND CANNOT CATCH, STATED AS CONSTRUCTION ───
 *
 * The asker chooses its own `refutes` id. A model that names a plausible claim
 * on every question passes {@link boundQuestions} unconditionally, and no
 * mechanical check can tell a real refutation target from a plausible one
 * without matching prose — which `defect-record.ts`'s header forbids by name,
 * citing the 2026-08-04 death. This ceiling is NOT closed here and must not be
 * described as closed. What detects it is §11.3's second metric,
 * {@link questionMetrics}`.changedDiagnosis`: "a Codex asker whose questions
 * never change a diagnosis is ceremony, and the honest response is to delete the
 * step rather than keep paying for it." The metric is deliberately self-refuting
 * and this module computes it rather than hiding it.
 *
 * ─── HELD-OUT CAUTION (§11.4), AND WHY THIS FILE HAS NO WRITER ───
 *
 * Question and answer text is derived from per-test failure evidence, which can
 * quote held-out assertion content verbatim. It is display-only: rendered to the
 * owner, never placed anywhere a build sandbox can read. THIS MODULE THEREFORE
 * WRITES NO FILE AND SPAWNS NO BUILD — it is pure data plus one injected model
 * seam. Nobody may later add a writer that lands this content under a run
 * workspace or feed it into a seat prompt: that is a held-out leak with no
 * tripwire. (Already true and separately recorded: `runs.db`'s `criteria.detail`
 * stores held-out test TITLES outside the sealed store.)
 *
 * ─── NOTHING CALLS THIS YET, AND THAT IS STATED RATHER THAN LEFT TO BE FOUND ───
 *
 * This lane built the question layer and wired nothing to it: there is no import
 * of this module anywhere in `dashboard/server/src` outside its own test. The
 * caller it is shaped for is the repair orchestrator (design §6, increment 3,
 * "not started"), which owns the defect record and the Claude seat that answers.
 * Until that exists, `askForQuestions` is reachable only from a test — so do not
 * read a green suite here as evidence that any run has ever asked a question.
 * §4's summary of this whole area applies to this file too: "the machinery is
 * real and the orchestration around it is not."
 *
 * ─── AND IT DECIDES NOTHING ───
 *
 * Same split `repair-author.ts` obeys and for the same reason: this file may not
 * grade, prove, apply or gate anything. It produces questions and answers with
 * their citations. The ablation still decides (§3C.2), and a Codex verdict is
 * not a gate arm.
 */

import { Codex } from "@openai/codex-sdk";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import type { DefectRecord } from "./defect-record.js";
import { subscriptionSubprocessEnvStrings } from "./subprocess-env.js";

/* -------------------------------------------------------------------------
 * 1. The typed question (§10.3 table, §11.2 row)
 * ---------------------------------------------------------------------- */

/**
 * The four sources whose answer is EVIDENCE, per §10.3's table.
 *
 * `OWNER` is deliberately not in this list: it is the absence of all four, not a
 * fifth kind of evidence, and keeping it out is what lets the type system say
 * "an evidenced answer has a citation" without qualification.
 */
export const EVIDENCE_SOURCES = ["CODE", "DATA", "EXPERIMENT", "CODEX"] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** §10.3's whole table: the four evidenced sources plus the park-and-email arm. */
export type QuestionSource = EvidenceSource | "OWNER";

/**
 * §11.2's grouping, as a value on the row rather than as a rendering decision.
 *
 * `UNANSWERED` is the outcome of every `OWNER` question and of no other: a
 * question the lane could not answer from any evidence source has, by
 * construction, not confirmed or changed anything.
 */
export type QuestionOutcome = "CHANGED_DIAGNOSIS" | "CONFIRMED" | "UNANSWERED";

/**
 * A question that was answered from evidence.
 *
 * `citation: string` — NOT `string | null`, and that is the type-level half of
 * the guard. An answer with no citation for CODE/DATA/EXPERIMENT/CODEX is not
 * merely rejected at runtime, it is not CONSTRUCTIBLE; `repair-questions.test.ts`
 * pins that with a `@ts-expect-error` line, so widening this field breaks the
 * build rather than quietly re-opening the hole.
 *
 * The five fields the lane brief names — `question`, `source`, `answer`,
 * `citation`, `outcome` — are present on BOTH arms of {@link RepairQuestion} so
 * a reader can read either arm against the brief. Two more are carried and each
 * one is forced by a section of the design:
 *
 *   `asker`   — §11.2's row is "asker · question · source tag · answer ·
 *               citation". A panel that cannot say who asked cannot show that
 *               the independent model is the one asking, which is the entire
 *               claim §10.5 makes.
 *   `claimId` — the claim the question probes ({@link DiagnosisClaim}). It is
 *               what {@link boundQuestions} filtered on, kept on the row so the
 *               panel can show WHY the question survived the bound.
 */
export interface AnsweredQuestion {
  readonly question: string;
  readonly source: EvidenceSource;
  readonly answer: string;
  readonly citation: string;
  readonly outcome: "CHANGED_DIAGNOSIS" | "CONFIRMED";
  readonly asker: string;
  readonly claimId: string;
}

/**
 * A question no evidence source could answer — §10.3's fifth row, §11.2's
 * `NEEDS YOU` group, and the second half of the owner's email (§10.4).
 *
 * `answer` and `citation` are `null` AND CANNOT BE ANYTHING ELSE. A string here
 * would be the model's priors wearing a park's clothing, which is the exact
 * collapse §10.3 exists to prevent: "asked itself a question" becoming "guessed
 * with extra steps".
 *
 * `why` is arm-specific because it has no meaning on the evidenced arm: it names
 * WHICH check refused the answer, so the email says what the lane could not
 * decide rather than only that it could not decide.
 */
export interface OwnerQuestion {
  readonly question: string;
  readonly source: "OWNER";
  readonly answer: null;
  readonly citation: null;
  readonly outcome: "UNANSWERED";
  readonly asker: string;
  readonly claimId: string;
  readonly why: string;
}

export type RepairQuestion = AnsweredQuestion | OwnerQuestion;

/* -------------------------------------------------------------------------
 * 2. The claim set — what a question is allowed to be ABOUT
 * ---------------------------------------------------------------------- */

/**
 * One thing the record asserts, with an id the asker can name.
 *
 * WHY THE CLAIMS COME FROM THE DEFECT RECORD AND NOT FROM A DIAGNOSIS. §10.5.3's
 * loop is `defect record -> CODEX asks -> CLAUDE answers -> diagnosis -> patch`:
 * at ask time THERE IS NO DIAGNOSIS YET. A bound that checked questions against
 * a diagnosis could not run at the point the design runs it. So the claim set is
 * minted from the record's own STRUCTURED fields (`defect-record.ts:186-224`),
 * shipped into the prompt with these ids, and the asker can only name a claim it
 * was shown.
 *
 * NOTHING HERE IS DERIVED FROM `failureReason`. That field is prose and
 * `defect-record.ts`'s header forbids reading it back, citing the 2026-08-04
 * death by name: "`failureReason` is carried verbatim into the record for a
 * human to read; nothing in this file reads it back." It is quoted into the
 * prompt as CONTEXT (a human-readable sentence for the asker) and is not a
 * claim, so no question can be kept on the strength of it.
 */
export interface DiagnosisClaim {
  readonly id: string;
  readonly statement: string;
}

/**
 * Per-test failure evidence as the ask sees it.
 *
 * DELIBERATELY A LOCAL STRUCTURAL MIRROR OF `bakeoff`'s `TestFailure`, AND
 * MEASURED RATHER THAN ASSUMED: at HEAD `ea80328` in this tree,
 * `grep -rn "MAX_PERSISTED_FAILURES\|parseTestFailures\|TestFailure"
 * bakeoff/src/ dashboard/server/src/` returns NOTHING. The design's §6.1 calls
 * increment 1 "PURE LOGIC DONE"; that work is not on this branch. Importing a
 * type that does not exist would make this module uncompilable, so the field
 * names are chosen to match `TestFailure`'s exactly (`titlePath`,
 * `criterionIds`, `name`, `message`, `code`, `expected`, `actual`) — a real
 * `TestFailure` is assignable to this interface the day increment 1 lands, with
 * no change here.
 *
 * Every field but `titlePath` is nullable because every runner attaches a
 * different subset, and an absent field is a FACT the asker should see: a
 * failure with a null `code` and a null `expected` is a different animal from an
 * `ERR_ASSERTION` with both.
 */
export interface FailureEvidence {
  readonly titlePath: string;
  readonly criterionIds: readonly string[];
  readonly name: string | null;
  readonly message: string | null;
  readonly code: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
}

/**
 * The claims a defect record makes about itself, each with a stable id.
 *
 * Ids are stable strings rather than indices into a list, because the asker
 * echoes them back and an index would silently re-point if a violation were
 * added. `claim:field:<path>` carries the path itself for the same reason.
 */
export function claimsFromDefect(
  defect: DefectRecord,
  evidence: readonly FailureEvidence[] = [],
): readonly DiagnosisClaim[] {
  const claims: DiagnosisClaim[] = [
    { id: "claim:site", statement: `The failure was raised at the structured site \`${defect.site}\`.` },
    { id: "claim:class", statement: `Its failure class is \`${defect.failureClass}\`, in phase \`${defect.phase}\`, terminal status \`${defect.status}\`.` },
  ];
  if (defect.bakeoffCode !== null) {
    claims.push({ id: "claim:code", statement: `The harness raised BakeoffError code \`${defect.bakeoffCode}\`.` });
  }
  if (defect.violationsAvailable) {
    for (const violation of defect.violations) {
      claims.push({
        id: `claim:field:${violation.path}`,
        statement: `The validator refused \`${violation.path}\`: expected ${violation.expected}, got ${violation.got}.`,
      });
    }
  }
  claims.push(
    defect.reproduction.available
      ? {
          id: "claim:repro",
          statement: `This command reproduces it on an isolated copy of HEAD: \`${defect.reproduction.command}\`. Why it runs there: ${defect.reproduction.why}`,
        }
      : {
          id: "claim:repro-absent",
          statement: `Nothing reproduces it: \`${defect.reproduction.code}\`. ${defect.reproduction.reason}`,
        },
  );
  // Named absences are claims too, and they are the ones most worth attacking:
  // `defect-record.ts`'s header calls a record that quietly reports zero "this
  // repository's signature defect with a JSON file behind it". A question that
  // asks whether an absence is really an absence can change the diagnosis.
  for (const gap of defect.unavailable) {
    claims.push({ id: `claim:gap:${gap.split(":")[0] ?? "unknown"}`, statement: `The record reports this as UNAVAILABLE, not as zero: ${gap}` });
  }
  for (const failure of evidence) {
    claims.push({
      id: `claim:test:${failure.titlePath}`,
      statement:
        `Test \`${failure.titlePath}\` failed: name=${failure.name ?? "null"} code=${failure.code ?? "null"} ` +
        `expected=${failure.expected ?? "null"} actual=${failure.actual ?? "null"} message=${failure.message ?? "null"} ` +
        `criteria=[${failure.criterionIds.join(", ")}]`,
    });
  }
  return claims;
}

/* -------------------------------------------------------------------------
 * 3. The prompt — what Codex is asked, and what it is forbidden to do
 * ---------------------------------------------------------------------- */

/** §10.5.3's question, verbatim. The test asserts the prompt contains it. */
export const THE_ASK =
  "what must be known before anyone claims to understand this defect?";

/**
 * The DEFAULT ceiling on how many questions may survive into the next stage.
 *
 * WHERE IT FIRES: in {@link boundQuestions}, as its `cap` parameter's default —
 * NOT in {@link parseAskedQuestions}, which reads everything the asker sent so
 * that `problems` can name the malformed entries. Stated because a constant
 * whose name says "asked" and whose enforcement lives in the filter is exactly
 * the read-the-mechanism-not-the-name trap this repository keeps falling into.
 *
 * THIS IS NOT THE §10.5.4 FILTER AND MUST NEVER BE READ AS ONE. §10.5.4 is
 * explicit that "the filter is not a count". This is a bound on how much text
 * one model turn can push into the next stage, and a question dropped by it is
 * recorded under its own reason (`OVER_CAP`) so it can never be mistaken for a
 * question that failed to earn its place.
 */
export const MAX_ASKED_QUESTIONS = 40;

/**
 * The prompt.
 *
 * IT STATES THE BOUND TO THE ASKER AS WELL AS ENFORCING IT AFTERWARDS. Enforcing
 * only would throw away most of a turn; stating only would be a guideline. Both,
 * because {@link boundQuestions} runs on the output regardless of what the
 * prompt said — a model that ignores the rule loses the questions, silently and
 * countably.
 *
 * IT FORBIDS ANSWERING. §10.5's whole point is that the asker and the answerer
 * are different models; an asker that supplies its own answers has re-created
 * the single-priors loop at one remove.
 */
export function buildAskPrompt(input: {
  readonly defect: DefectRecord;
  readonly claims: readonly DiagnosisClaim[];
  readonly maxQuestions?: number;
}): string {
  const cap = input.maxQuestions ?? MAX_ASKED_QUESTIONS;
  const lines: string[] = [
    "You are the ASKER. A separate model will answer; you will not, and an answer you supply is discarded.",
    "",
    `THE ONE QUESTION YOU ARE HERE TO ANSWER WITH MORE QUESTIONS: ${THE_ASK}`,
    "",
    "THE DEFECT RECORD, as structured fields. These are the CLAIMS. Each has an id you must use.",
    "",
  ];
  for (const claim of input.claims) lines.push(`  ${claim.id}  ${claim.statement}`);
  lines.push(
    "",
    "CONTEXT, NOT A CLAIM — the failure text a human would read. It is prose; nothing in this",
    "pipeline parses it and no question may rest on it alone:",
    `  ${input.defect.failureReason ?? "(none recorded)"}`,
    "",
    "THE BOUND. Keep only questions whose SURPRISING answer would CHANGE the diagnosis.",
    '  "What does line 400 do?" — the answer changes nothing. Do not ask it.',
    '  "Is `details.error` the thrown error?" — if the answer is no, the diagnosis dies. Ask it.',
    "A question that cannot change the outcome observes nothing, exactly as a test that cannot go",
    "red observes nothing. Questions that name no claim, or whose surprising answer you cannot",
    "state, are dropped by a filter before anyone reads them.",
    "",
    `Return AT MOST ${String(cap)} questions as a JSON array and nothing else. Each entry:`,
    '  {"question": "...", "refutes": "<one claim id from the list above>", "surprisingAnswer": "what the answer would be if the claim is wrong"}',
    "",
    "Do not propose a patch. Do not diagnose. Do not answer your own questions.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * 4. Parsing the asker's reply
 * ---------------------------------------------------------------------- */

/** One question as the asker returned it, before the bound. */
export interface AskedQuestion {
  readonly question: string;
  /** The id of the claim whose falsity this question probes. */
  readonly refutes: string;
  /** What the answer would be if the claim is wrong. Empty means "no surprise exists". */
  readonly surprisingAnswer: string;
}

/**
 * The first top-level JSON array in a model's reply.
 *
 * Brace-counting rather than a regex, and string-aware, because a question is
 * prose and prose contains brackets. `repair-author.ts#extractJsonObject` does
 * the same for objects; this is its array twin and is deliberately a separate
 * function rather than a generalisation, so a change to one cannot silently
 * change the other's behaviour on an authored diff.
 */
export function extractJsonArray(text: string): readonly unknown[] | null {
  /*
   * EVERY CANDIDATE BRACKET, NOT THE FIRST ONE. Corrected 2026-08-16.
   *
   * This used to lock onto `text.indexOf("[")`, so a single bracketed token
   * anywhere in the asker's prose — "[1]", "[see below]", a markdown link — was
   * treated as the start of the array. The scan then found a balanced `]`
   * immediately, `JSON.parse` failed, and the function returned null: THE WHOLE
   * QUESTION SET WAS DISCARDED and the caller reported an asker that returned
   * nothing. An independent model is being paid to produce those questions, and
   * one stray bracket in its preamble threw all of them away.
   *
   * Trying each `[` in turn and keeping the first that parses to an array is
   * bounded by the number of brackets and cannot be worse than the old
   * behaviour: the old start position is simply the first candidate.
   */
  for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
    const found = scanArrayFrom(text, start);
    if (found !== null) return found;
  }
  return null;
}

/** One attempt, from a known `[`. Null when it does not close or does not parse. */
function scanArrayFrom(text: string, start: number): readonly unknown[] | null {
  {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
  }
}

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value.trim() : null;
}

/**
 * Asked questions, plus a named problem for every entry that was not one.
 *
 * LOUD ON MALFORMED, NEVER SILENT. `problems` is how "the asker returned
 * nothing" is told apart from "the asker returned eight things and none of them
 * had a `refutes` key" — absence is not emptiness, the rule
 * `defect-record.ts`'s header is built on.
 */
export function parseAskedQuestions(text: string): {
  readonly asked: readonly AskedQuestion[];
  readonly problems: readonly string[];
} {
  const rows = extractJsonArray(text);
  if (rows === null) return { asked: [], problems: ["the reply contained no JSON array"] };
  const asked: AskedQuestion[] = [];
  const problems: string[] = [];
  rows.forEach((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      problems.push(`entry ${String(index)} is not an object`);
      return;
    }
    const record = row as Record<string, unknown>;
    const question = readString(record, "question");
    const refutes = readString(record, "refutes");
    const surprisingAnswer = readString(record, "surprisingAnswer");
    if (question === null || question.length === 0) {
      problems.push(`entry ${String(index)} has no question text`);
      return;
    }
    asked.push({
      question,
      refutes: refutes ?? "",
      surprisingAnswer: surprisingAnswer ?? "",
    });
  });
  return { asked, problems };
}

/* -------------------------------------------------------------------------
 * 5. THE BOUND (§10.5.4)
 * ---------------------------------------------------------------------- */

/**
 * Why a question was dropped. Each value is a different fact about the asker and
 * they are never collapsed into one count.
 *
 *   `NAMES_NO_CLAIM` — it refutes nothing in the record, so no answer to it can
 *                      change the diagnosis. This is the bound proper.
 *   `NO_SURPRISE`    — the asker could not state what a surprising answer would
 *                      be, which is the same statement in the asker's own words.
 *   `DUPLICATE`      — same claim, same surprising answer, asked twice.
 *   `OVER_CAP`       — {@link MAX_ASKED_QUESTIONS}. NOT the bound; see that
 *                      constant's docblock.
 */
export type DropReason = "NAMES_NO_CLAIM" | "NO_SURPRISE" | "DUPLICATE" | "OVER_CAP";

export interface DroppedQuestion {
  readonly question: AskedQuestion;
  readonly reason: DropReason;
}

export interface BoundedQuestions {
  readonly kept: readonly AskedQuestion[];
  readonly dropped: readonly DroppedQuestion[];
}

/**
 * §10.5.4, as a filter: keep only questions whose surprising answer would CHANGE
 * the diagnosis.
 *
 * MECHANICALLY, that is two conjuncts and a dedup:
 *
 *   1. The question must name a claim THE RECORD ACTUALLY MAKES. An id the
 *      prompt never showed is either an invention or a stale reference, and in
 *      both cases the answer bears on nothing that is being claimed.
 *   2. The asker must be able to state the surprising answer. "There is no
 *      answer that would surprise me" is the asker saying the question cannot
 *      change the outcome; taking it at its word costs nothing and drops the
 *      wallpaper §11.2 warns about.
 *   3. Two questions with the same claim and the same surprising answer are one
 *      question. The second costs an evidence lookup and can move nothing the
 *      first did not already move.
 *
 * THE CEILING, NAMED: the asker picks its own `refutes`, so a model that attaches
 * a plausible claim id to every question passes conjunct 1 every time. That
 * cannot be closed without matching prose, which this repository forbids. What
 * detects it is {@link questionMetrics}`.changedDiagnosis` trending to zero —
 * §11.3's deliberately self-refuting metric.
 *
 * `cap` IS A PARAMETER AND NOT A READ OF {@link MAX_ASKED_QUESTIONS}, because
 * {@link askForQuestions} lets a caller state a smaller number IN THE PROMPT. A
 * filter that ignored it would tell the asker "at most 5" and then admit forty —
 * the stated bound and the enforced bound disagreeing, which is worse than
 * having no bound because only one of the two is visible in the transcript.
 */
export function boundQuestions(
  asked: readonly AskedQuestion[],
  claims: readonly DiagnosisClaim[],
  cap: number = MAX_ASKED_QUESTIONS,
): BoundedQuestions {
  const known = new Set(claims.map((claim) => claim.id));
  const seen = new Set<string>();
  const kept: AskedQuestion[] = [];
  const dropped: DroppedQuestion[] = [];
  for (const question of asked) {
    if (!known.has(question.refutes)) {
      dropped.push({ question, reason: "NAMES_NO_CLAIM" });
      continue;
    }
    if (question.surprisingAnswer.trim().length === 0) {
      dropped.push({ question, reason: "NO_SURPRISE" });
      continue;
    }
    const fingerprint = `${question.refutes}\u0000${question.surprisingAnswer.trim().toLowerCase()}`;
    if (seen.has(fingerprint)) {
      dropped.push({ question, reason: "DUPLICATE" });
      continue;
    }
    if (kept.length >= cap) {
      dropped.push({ question, reason: "OVER_CAP" });
      continue;
    }
    seen.add(fingerprint);
    kept.push(question);
  }
  return { kept, dropped };
}

/* -------------------------------------------------------------------------
 * 6. THE GUARD (§10.3) — the citation shapes, per source
 * ---------------------------------------------------------------------- */

/**
 * What separates the parts of a compound citation.
 *
 * A single separator string for DATA, EXPERIMENT and CODEX so there is one thing
 * to teach the answerer and one thing to test. ` :: ` rather than a bare colon
 * because a CODE citation IS `path:line` and reusing the colon would make the
 * two shapes ambiguous.
 */
export const CITATION_SEPARATOR = " :: ";

/** `dashboard/server/src/defect-record.ts:186` — §10.3's "a `file:line`". */
const CODE_CITATION = /^[A-Za-z0-9._/-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?$/u;

/** §10.3's "a query against `dashboard/data/runs.db` or `results/`". */
const DATA_TARGET = /^(?:[A-Za-z0-9._/-]*runs\.db|[A-Za-z0-9._/-]*results\/[A-Za-z0-9._/-]*)$/u;

/** §10.3's "an exit code from something actually run". */
const EXIT_CODE = /^exit -?\d+$/u;

/** Provenance for the §10.5.5 arm: which thread said it. */
const CODEX_THREAD = /^codex:[A-Za-z0-9._-]+$/u;

function splitFirst(citation: string): readonly [string, string] | null {
  const at = citation.indexOf(CITATION_SEPARATOR);
  if (at < 0) return null;
  return [citation.slice(0, at), citation.slice(at + CITATION_SEPARATOR.length)];
}

function splitLast(citation: string): readonly [string, string] | null {
  const at = citation.lastIndexOf(CITATION_SEPARATOR);
  if (at < 0) return null;
  return [citation.slice(0, at), citation.slice(at + CITATION_SEPARATOR.length)];
}

/**
 * Null if this citation is the shape §10.3's table demands for this source;
 * otherwise the reason it is not, phrased for the owner's email.
 *
 * THE SHAPE CHECK IS THE POINT, NOT THE EMPTINESS CHECK. A validator that only
 * asked "is the citation non-empty" would accept `citation: "yes"` for CODE, and
 * the guard would observe nothing — the defect this repository is named for,
 * wearing a validator's clothes. Each source gets the shape its row names:
 *
 *   CODE       `path.ext:line` (or `:line-line`)
 *   DATA       `<runs.db | …results/…> :: <the query>`
 *   EXPERIMENT `<the command> :: exit <n>`
 *   CODEX      `codex:<thread> :: <a CODE, DATA or EXPERIMENT citation>`
 *
 * THIS IS FORMAT VALIDATION ON A STRUCTURED FIELD, NOT PROSE PARSING. It does not
 * collide with `defect-record.ts`'s "nothing here parses prose" rule: the
 * citation is a machine field with a stated grammar, and the answer text beside
 * it is never read.
 */
export function citationProblem(source: EvidenceSource, citation: string | null): string | null {
  if (citation === null || citation.trim().length === 0) {
    return `a ${source} answer with no citation is not an answer — §10.3 requires the source to be named before the question is answered`;
  }
  const value = citation.trim();
  switch (source) {
    case "CODE": {
      if (!CODE_CITATION.test(value)) {
        return `a CODE citation must be a file:line, e.g. dashboard/server/src/defect-record.ts:186 — got \`${value}\``;
      }
      return null;
    }
    case "DATA": {
      const parts = splitFirst(value);
      if (parts === null || !DATA_TARGET.test(parts[0]) || parts[1].trim().length === 0) {
        return `a DATA citation must be \`<runs.db or a results/ path>${CITATION_SEPARATOR}<the query that was run>\` — got \`${value}\``;
      }
      return null;
    }
    case "EXPERIMENT": {
      const parts = splitLast(value);
      if (parts === null || parts[0].trim().length === 0 || !EXIT_CODE.test(parts[1].trim())) {
        return `an EXPERIMENT citation must be \`<the command>${CITATION_SEPARATOR}exit <n>\` — §10.3 asks for an exit code from something actually run, and got \`${value}\``;
      }
      return null;
    }
    case "CODEX": {
      const parts = splitFirst(value);
      if (parts === null || !CODEX_THREAD.test(parts[0])) {
        return `a CODEX citation must begin \`codex:<threadId>${CITATION_SEPARATOR}\` so the reading is attributable — got \`${value}\``;
      }
      const underlying = parts[1].trim();
      const asCode = citationProblem("CODE", underlying);
      const asData = citationProblem("DATA", underlying);
      const asExperiment = citationProblem("EXPERIMENT", underlying);
      if (asCode !== null && asData !== null && asExperiment !== null) {
        // §10.5.5, quoted because it is the whole reason this branch exists:
        // "Two models agreeing is still two models agreeing — it is not
        // evidence." Codex is a ROUTE to evidence, never a kind of it.
        return `a CODEX citation must carry the evidence Codex pointed AT — a file:line, a query or a command with an exit code — after the thread id. Two models agreeing is not evidence (§10.5.5). Got \`${underlying}\``;
      }
      return null;
    }
    default: {
      // Exhaustive over EvidenceSource; kept so a future source cannot be added
      // without a shape, which would re-open the "non-empty is enough" hole.
      return `no citation shape is defined for source \`${String(source)}\``;
    }
  }
}

/* -------------------------------------------------------------------------
 * 7. Answering — and the routing that makes OWNER the default, not CODE
 * ---------------------------------------------------------------------- */

/**
 * What the answering seat claims, before anything has been checked.
 *
 * `source` is `QuestionSource | null` and not `EvidenceSource`: an answerer that
 * could not assign a source must be able to SAY so, and the null case must land
 * on the same arm as a failed check. §10.3: "A question that cannot be assigned
 * one of the first four IS the fifth. No exceptions."
 */
export interface AnswerAttempt {
  /** Must equal the asked question's text; that is how the two are joined. */
  readonly question: string;
  readonly source: QuestionSource | null;
  readonly answer: string | null;
  readonly citation: string | null;
  /**
   * Did the answer contradict what the record claimed? §11.2's grouping and
   * §11.3's second metric both read this and nothing else.
   *
   * THE SECOND CEILING, NAMED FOR THE SAME REASON AS THE BOUND'S. This flag is
   * SELF-REPORTED by the answering seat, and §11.3's "is Codex-as-asker earning
   * its cost?" rests entirely on it — so a seat that marked everything
   * `CHANGED_DIAGNOSIS` would make the asker look indispensable, and one that
   * marked nothing would make it look like ceremony, in both cases with no
   * mechanical contradiction anywhere. It is not closable here: deciding whether
   * an answer really moved a diagnosis needs the diagnosis, which does not exist
   * until after this stage (see {@link DiagnosisClaim}).
   *
   * WHAT WOULD DETECT DRIFT: the join nobody has built yet — a question marked
   * `CHANGED_DIAGNOSIS` whose claim still appears unchanged in the patch the
   * lane went on to author. Recorded as the open item it is, rather than left
   * for a reader to assume this number is measured.
   */
  readonly changedDiagnosis: boolean;
}

/**
 * One asked question plus one attempt, resolved into a {@link RepairQuestion}.
 *
 * EVERY FAILURE PATH LANDS ON `OWNER`, AND THAT IS THE RULE RATHER THAN A
 * FALLBACK. No attempt, a null source, an `OWNER` source, an empty answer, a
 * missing citation, a citation of the wrong shape — all five are "this question
 * could not be assigned CODE/DATA/EXPERIMENT/CODEX", which §10.3 says IS an
 * OWNER question. Defaulting any of them to an evidenced source would be the
 * lane answering from its priors and calling it evidence, which is the single
 * thing §10.3 exists to make impossible.
 */
export function resolveAnswer(
  asked: AskedQuestion,
  attempt: AnswerAttempt | null,
  asker: string,
): RepairQuestion {
  const park = (why: string): OwnerQuestion => ({
    question: asked.question,
    source: "OWNER",
    answer: null,
    citation: null,
    outcome: "UNANSWERED",
    asker,
    claimId: asked.refutes,
    why,
  });
  if (attempt === null) return park("no answer was produced for this question");
  if (attempt.source === null) {
    return park("the answerer could not name an evidence source, and §10.3 makes that an OWNER question");
  }
  if (attempt.source === "OWNER") {
    return park("the answerer routed this to the owner: none of CODE, DATA, EXPERIMENT or CODEX applies");
  }
  const answer = attempt.answer === null ? "" : attempt.answer.trim();
  if (answer.length === 0) {
    return park(`a ${attempt.source} source was named but no answer was given`);
  }
  const problem = citationProblem(attempt.source, attempt.citation);
  if (problem !== null) return park(problem);
  return {
    question: asked.question,
    source: attempt.source,
    answer,
    // Non-null by construction: `citationProblem` returns a problem for null and
    // for empty, so reaching here means a trimmed, shaped string exists.
    citation: (attempt.citation ?? "").trim(),
    outcome: attempt.changedDiagnosis ? "CHANGED_DIAGNOSIS" : "CONFIRMED",
    asker,
    claimId: asked.refutes,
  };
}

/**
 * The kept questions, each resolved against the attempt that names it.
 *
 * `ignoredAttempts` IS RETURNED RATHER THAN DROPPED ON THE FLOOR, and it carries
 * TWO different kinds of ignored answer because both are the answering seat
 * drifting from the asked set:
 *
 *   1. An answer to a question nobody asked. It cannot be rendered in a panel
 *      keyed by question, but a count of zero has to mean "there were none"
 *      rather than "nobody looked".
 *   2. A SECOND answer to a question already answered. The map is FIRST-WINS, so
 *      the later one is superseded — and a last-wins map would have made a
 *      contradicting second answer replace the first with nothing anywhere
 *      saying it happened. Two answers to one question is exactly the event a
 *      reader of this panel needs to see.
 */
export function resolveQuestions(
  kept: readonly AskedQuestion[],
  attempts: readonly AnswerAttempt[],
  asker: string,
): {
  readonly questions: readonly RepairQuestion[];
  readonly ignoredAttempts: readonly string[];
} {
  const byQuestion = new Map<string, AnswerAttempt>();
  const superseded: string[] = [];
  for (const attempt of attempts) {
    if (byQuestion.has(attempt.question)) superseded.push(attempt.question);
    else byQuestion.set(attempt.question, attempt);
  }
  const used = new Set<string>();
  const questions = kept.map((asked) => {
    const attempt = byQuestion.get(asked.question) ?? null;
    if (attempt !== null) used.add(asked.question);
    return resolveAnswer(asked, attempt, asker);
  });
  const unmatched = attempts
    .filter((attempt) => !used.has(attempt.question))
    .map((attempt) => attempt.question);
  return { questions, ignoredAttempts: [...new Set([...unmatched, ...superseded])] };
}

/* -------------------------------------------------------------------------
 * 8. The Codex seam (§3C, §10.5)
 * ---------------------------------------------------------------------- */

export interface CodexAskRequest {
  readonly prompt: string;
  readonly timeoutMs: number;
  /** Recorded on the journal row by the caller; never sent to the model. */
  readonly purpose: string;
}

export interface CodexAskResult {
  readonly text: string;
  /** Null on success. Never a thrown exception: a dead asker must not kill a repair. */
  readonly failure: string | null;
  /** Provenance for a `CODEX` citation. Null when the turn never started. */
  readonly threadId: string | null;
}

/** One call to the independent model. Injected so no test ever spends quota. */
export type CodexAsk = (request: CodexAskRequest) => Promise<CodexAskResult>;

/**
 * The two SDK surfaces this file uses, as structural types.
 *
 * WHY NOT THE SDK'S OWN CLASSES: a fake must be constructible in a test without
 * a `codex` binary on PATH. `Codex` and `Thread` are assignable to these — the
 * default factory below is the proof, since it typechecks — so the production
 * path has no test-only branch in it.
 */
export interface CodexThreadLike {
  readonly id: string | null;
  run(input: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly finalResponse: string }>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export type CodexClientFactory = (options: CodexOptions) => CodexClientLike;

/**
 * How the asker's thread is configured, and every field is a decision.
 *
 * `sandboxMode: "read-only"` — DIFFERENT FROM `codex-builder.ts:137`, which uses
 * `workspace-write` because a builder that cannot write cannot build. An asker
 * writes nothing: it reads the repository so its questions are informed, and a
 * write from it would be an unreviewed edit by the model the design explicitly
 * keeps advisory (§3C.2: "Codex reviews; it does not decide"). `read-only` is a
 * first-class `SandboxMode` in the SDK's own types
 * (`@openai/codex-sdk/dist/index.d.ts:238`).
 *
 * `approvalPolicy: "never"` — same reason as the builder: there is no human in
 * the room, which is the premise of the whole lane.
 *
 * `networkAccessEnabled: false` — also different from the builder, which leaves
 * it on so a build can install a dependency. An asker installs nothing, and the
 * narrower setting is free here.
 *
 * `skipGitRepoCheck: true` — the asker runs against the REPOSITORY, not against
 * an orchestrator-initialised run workspace, and the check exists to catch a
 * missing repo in the latter case. It is set explicitly rather than defaulted so
 * the difference from the builder is visible at the declaration.
 */
export const CODEX_ASKER_THREAD_OPTIONS: ThreadOptions = Object.freeze({
  sandboxMode: "read-only",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  skipGitRepoCheck: true,
});

/**
 * The production seam.
 *
 * THE ENVIRONMENT IS SUBTRACTED, NOT FORWARDED, AND THAT IS A BILLING CONTROL
 * RATHER THAN HYGIENE. `CodexOptions.env` REPLACES the child environment
 * entirely (`codex-builder.ts:127-133`), and the CLI will authenticate with
 * `CODEX_API_KEY`/`OPENAI_API_KEY` if it finds one — which would move the
 * owner's repair traffic from their subscription onto a metered API bill with no
 * other visible change. {@link subscriptionSubprocessEnvStrings}
 * (`subprocess-env.ts:124`) removes those two and eleven relatives —
 * `STRIPPED_ENV_NAMES` is thirteen entries at `subprocess-env.ts:39-55` — while
 * preserving PATH, HOME and CODEX_HOME, because it is a SUBTRACTION and not an
 * allowlist. NOTE THE ABSENT OPTION: no `apiKey`.
 *
 * A FRESH CLIENT AND THREAD PER CALL, and the abort controller is per call for
 * the same reason `repair-author.ts#createSeatPatchAuthorCall` builds a fresh
 * caller: a timeout on one turn must not kill the next.
 *
 * IT NEVER THROWS. A failed ask returns `failure` and empty text, because §10.5.2
 * makes questions purely additive — "a bad question costs one evidence lookup" —
 * so an asker that cannot be reached must degrade the repair to no questions,
 * never to no repair.
 */
export function createCodexAsk(deps: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly factory?: CodexClientFactory;
}): CodexAsk {
  const factory: CodexClientFactory = deps.factory ?? ((options) => new Codex(options));
  return async (request: CodexAskRequest): Promise<CodexAskResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, request.timeoutMs);
    timer.unref();
    /*
     * INSIDE THE TRY, BECAUSE "IT NEVER THROWS" WAS FALSE. Corrected 2026-08-16.
     *
     * `factory(...)` and `startThread(...)` sat above the `try`, so a missing
     * Codex login, an unreadable config or an SDK that cannot spawn its binary
     * REJECTED this promise — and `askForQuestions` has no catch, so the whole
     * repair died at the question step with a raw SDK error instead of the
     * `failure` string this function exists to return. The one dependency most
     * likely to be absent on a fresh machine was the one outside the guard.
     */
    let thread: { readonly id: string | null; run: (prompt: string, options: { signal: AbortSignal }) => Promise<{ finalResponse: string }> };
    try {
      const client = factory({ env: subscriptionSubprocessEnvStrings(deps.env) });
      thread = client.startThread({ ...CODEX_ASKER_THREAD_OPTIONS, workingDirectory: deps.cwd });
    } catch (error) {
      clearTimeout(timer);
      return {
        text: "",
        failure: `the asker could not be started: ${error instanceof Error ? error.message : String(error)}`,
        threadId: null,
      };
    }
    try {
      const turn = await thread.run(request.prompt, { signal: controller.signal });
      return { text: turn.finalResponse, failure: null, threadId: thread.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: "",
        failure: controller.signal.aborted ? `the asker did not answer within ${String(request.timeoutMs)}ms` : message,
        threadId: thread.id,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Ask, parse, bound. The whole front half of §10.5.3's loop, in one call.
 *
 * The answering half is NOT here and must not be: it belongs to the Claude seat
 * that can read a file and run a command, and a function that both asked and
 * answered would be the single-priors loop this design paid a second model to
 * break.
 */
export async function askForQuestions(input: {
  readonly ask: CodexAsk;
  readonly defect: DefectRecord;
  readonly claims: readonly DiagnosisClaim[];
  readonly timeoutMs: number;
  readonly maxQuestions?: number;
}): Promise<{
  readonly bounded: BoundedQuestions;
  readonly problems: readonly string[];
  readonly threadId: string | null;
  readonly failure: string | null;
}> {
  const prompt = buildAskPrompt(
    input.maxQuestions === undefined
      ? { defect: input.defect, claims: input.claims }
      : { defect: input.defect, claims: input.claims, maxQuestions: input.maxQuestions },
  );
  const result = await input.ask({ prompt, timeoutMs: input.timeoutMs, purpose: "repair-questions" });
  if (result.failure !== null) {
    return {
      bounded: { kept: [], dropped: [] },
      problems: [`the asker failed: ${result.failure}`],
      threadId: result.threadId,
      failure: result.failure,
    };
  }
  const parsed = parseAskedQuestions(result.text);
  return {
    // THE SAME NUMBER THE PROMPT STATED. `buildAskPrompt` above prints this cap
    // to the asker; passing anything else here would enforce a bound the model
    // was never told about.
    bounded: boundQuestions(parsed.asked, input.claims, input.maxQuestions ?? MAX_ASKED_QUESTIONS),
    problems: parsed.problems,
    threadId: result.threadId,
    failure: null,
  };
}

/* -------------------------------------------------------------------------
 * 9. §11 — the panel's data shape, and the metric that can kill the feature
 * ---------------------------------------------------------------------- */

/**
 * §11.2's three groups, grouped by OUTCOME and never by order.
 *
 * "Chronological order is close to useless: most questions confirm what was
 * already assumed, and burying the two that did not inside eighteen that did is
 * how a panel becomes wallpaper."
 *
 * `needsYou` is the same set that populates the second half of the owner's email
 * (§10.4), so the panel and the report cannot drift: one source, two renderings.
 */
export interface QuestionPanel {
  readonly needsYou: readonly OwnerQuestion[];
  readonly changedDiagnosis: readonly AnsweredQuestion[];
  readonly confirmed: readonly AnsweredQuestion[];
}

export function groupQuestions(questions: readonly RepairQuestion[]): QuestionPanel {
  const needsYou: OwnerQuestion[] = [];
  const changedDiagnosis: AnsweredQuestion[] = [];
  const confirmed: AnsweredQuestion[] = [];
  for (const question of questions) {
    if (question.source === "OWNER") needsYou.push(question);
    else if (question.outcome === "CHANGED_DIAGNOSIS") changedDiagnosis.push(question);
    else confirmed.push(question);
  }
  return { needsYou, changedDiagnosis, confirmed };
}

/**
 * §11.3's two metrics.
 *
 * `owner` — OWNER-tagged questions per run, over time. "Is the lane becoming
 * more autonomous? Trending to zero is the goal."
 *
 * `changedDiagnosis` — "IS CODEX-AS-ASKER EARNING ITS COST?" This one is
 * deliberately self-refuting and is the reason it is computed here rather than
 * left to a dashboard query. §10.5 argues an independent asker catches the class
 * of defect a reviewer misses; if that argument is wrong, THIS NUMBER IS WHERE
 * IT SHOWS. {@link QuestionMetrics.askerChangedNothing} states it as a boolean so
 * nobody has to notice a zero: a Codex asker whose questions never change a
 * diagnosis is ceremony, and the honest response is to delete the step rather
 * than keep paying for it. A feature that cannot display its own failure is the
 * defect this repository is named for.
 */
export interface QuestionMetrics {
  readonly total: number;
  readonly owner: number;
  readonly changedDiagnosis: number;
  readonly confirmed: number;
  /** True when questions were asked and none of them moved anything. */
  readonly askerChangedNothing: boolean;
}

export function questionMetrics(questions: readonly RepairQuestion[]): QuestionMetrics {
  const panel = groupQuestions(questions);
  return {
    total: questions.length,
    owner: panel.needsYou.length,
    changedDiagnosis: panel.changedDiagnosis.length,
    confirmed: panel.confirmed.length,
    askerChangedNothing: questions.length > 0 && panel.changedDiagnosis.length === 0,
  };
}
