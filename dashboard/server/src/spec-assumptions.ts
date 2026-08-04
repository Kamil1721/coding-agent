/**
 * spec-assumptions.ts — what the grader believed the owner meant, written down.
 *
 * WHY THIS EXISTS. The bake-off graded frozen, harness-authored briefs, where a
 * criterion and the ticket were written by the same hand in the same hour. The
 * dashboard grades what the owner actually types, which is "portfolio website",
 * and then they go to bed. Between those two sentences the spec agent invents a
 * dozen requirements — a hero, three projects, a contact form, a 200 on every
 * route — and the run is graded against those. So the dangerous outcome is not
 * a red badge. It is a GREEN one: a pass against criteria the owner never saw
 * and would not have agreed to. That is a false pass, and it is worse than a
 * failure because nothing downstream disagrees with it.
 *
 * WHAT THIS MODULE DOES NOT DO: STOP THE INFERENCE. A grader that refused to
 * infer would demand a specification from someone who wanted to type one line,
 * which is the product this replaces. Inference stays. This module makes each
 * inference VISIBLE and NAMED, so the correction lands on the TICKET — where it
 * is one sentence — rather than on the code, where it is a fix round.
 *
 * IT ALSO GATES NOTHING. Nothing here can fail a run, flip `heldOutPass`, or
 * reach criterion authoring; it reads a ticket and a criteria array and returns
 * prose. Same boundary as `judge.ts`: a record the owner reads, not a verdict.
 *
 * ─── THE TRACING RULE, AND WHY AN ENGLISH STOPWORD LIST IS NOT ENOUGH ───
 *
 * A criterion is `ticket`-sourced when it shares at least
 * {@link MIN_SHARED_CONTENT_TOKENS} content tokens with the ticket. The whole
 * question is what counts as a content token, and the obvious answer is wrong.
 *
 * Take ticket "Build a site for the studio" against criterion "the build is for
 * a site and the thing shall be there". Every ordinary stopword list — the, a,
 * for, is, and, shall — leaves {build, site} shared, because `build` and `site`
 * ARE content words in English. Match on that and the criterion is stamped
 * "traced to your ticket": the owner reads that the grader assumed nothing, and
 * the inference it actually made is now invisible and endorsed.
 *
 * So the filter is two lists, and both are load-bearing:
 *   1. {@link STOPWORDS} — function words. English carries no information here.
 *   2. {@link TICKET_BOILERPLATE} — words that are contentful in English and
 *      empty in THIS domain, because every ticket contains them: build, make,
 *      site, page, app, thing. A hand-built IDF floor for a corpus of one.
 * Delete either and the negative control in the test file goes red. That is
 * deliberate — it is the only evidence that the tracer traces anything.
 *
 * WHY TWO SHARED TOKENS AND NOT ONE. One word in common is a coincidence of
 * vocabulary; two is a phrase the owner typed. The consequence is that a thin
 * ticket ("portfolio website" — one distinctive word) can support NO criterion,
 * so everything reads as inferred. That is the correct report, not a defect:
 * with one word of input, everything downstream is a guess.
 *
 * THE ERRORS ARE NOT SYMMETRIC, and the threshold is set for the cheap one.
 *   Calling an inference `ticket`  — hides it. The owner never reviews it, and
 *                                    the green badge keeps its false claim.
 *   Calling a ticket line `inferred` — noise. It appears in a list the owner is
 *                                    already reading and they recognise their
 *                                    own words.
 * Every tie in this module breaks toward `inferred`, and stemming is kept
 * shallow for the same reason: an aggressive stemmer manufactures overlap, and
 * manufactured overlap is the first error, not the second.
 *
 * THE PLAN PHASE ADDS A SECOND WAY FOR A CRITERION TO BE THE OWNER'S — he can
 * have ANSWERED a question about it before anything was frozen. That source and
 * the rule that keeps it honest are documented at {@link AnsweredQuestion}; the
 * two lists above are what it matches on too, and the asymmetry argument below
 * governs it unchanged.
 *
 * ACCOUNTING IS THE INVARIANT. `extractAssumptions` emits exactly one record per
 * criterion. A criterion that produced no record is an inference nobody can see,
 * which is the failure this module exists to prevent — silence, not error.
 * `criterionId` is nullable because Task 3/5 may attach ticket-level notes to
 * the same record; this function does not produce one.
 */

import type { AcceptanceCriterion } from "bakeoff/dist/contracts.js";
// A VALUE import, deliberately. `import type` erases at runtime, and the drift
// test that compares {@link GATE_LABELS} against this list would then be
// comparing the table against nothing — a check that can only observe success.
import { GATE_IDS, GATE_ID_PREFIX } from "bakeoff/dist/scorer-protocol.js";
// A TYPE import, and for once that is the STRONGER check rather than the weaker
// one. See {@link DOM_FINDING_LABELS}: the table is keyed by this union, so a
// kind added or removed upstream is a COMPILE error here. A runtime drift test
// is not available for it — there is no `ALL_DOM_FINDING_KINDS` constant to
// import — and the type system is what stands in for one.
import type { DomFindingKind } from "bakeoff/dist/scorer-protocol.js";

/**
 * Where a criterion came from.
 *
 * `default` is not a weaker `inferred`. It means the criterion came from the
 * house rules — the Tier-0 gates that run on every artefact whatever the ticket
 * says — so it is not a guess about the owner's intent and there is nothing for
 * them to correct. Filing "the build succeeds" under INFERRED would bury the two
 * or three real inferences under boilerplate, and a review document that is
 * mostly boilerplate stops being read.
 *
 * `answered` is the plan phase's, and it is a SECOND KIND OF "the owner said
 * so", not a weaker `ticket`. The dashboard asked him a question before anything
 * was frozen and he typed a reply; a criterion resting on that reply is not a
 * guess. It is kept apart from `ticket` because the two invite different
 * corrections — a `ticket` line is one he can edit, an `answered` line is one he
 * settled in a conversation that is over — and because keeping them apart is the
 * only way to measure whether asking him changed anything.
 *
 * `reference` is the owner's too, at one remove. He chose the page; a duration
 * read off it is a fact he supplied without being a sentence he typed. Folding
 * it into `ticket` would credit him with a number he never saw; folding it into
 * `inferred` would call his own reference a guess by the grader. Both are lies
 * in opposite directions, so it gets its own name — the same argument that
 * earned `answered` its own case.
 *
 * WHAT SETS IT: {@link referenceSupportFor}, from a {@link ReferenceReading} the
 * caller passes BESIDE the prose. It is documented at {@link ReferenceReading},
 * and the one thing worth knowing here is that it is not "a reading exists" — a
 * criterion has to carry words the reading MEASURED before it lands in this
 * bucket. It landed as an unset union member first (2026-08-04) and every motion
 * criterion read as `inferred` for as long as that was true.
 */
export type AssumptionSource = "ticket" | "inferred" | "default" | "answered" | "reference";

/**
 * True when the owner himself is the source — by ticket, by answer, or by a page
 * he pointed at.
 *
 * ONE EXPRESSION, THREE CONSUMERS, and until this existed that claim was false:
 * `run-report.ts:countInferredAssumptions` and `verdict.ts:renderAssumptionSummary`
 * each carried their own `source !== "ticket"`, with a comment in the first
 * saying it was "copied from verdict.ts deliberately". Two copies of a predicate
 * that has just grown a fourth case is how the API count and the page the owner
 * reads end up disagreeing about which criteria he stated.
 *
 * `reference` IS COUNTED AS HIS, AND THAT DECIDES A HEADLINE NUMBER.
 * `countInferredAssumptions` is this predicate negated, and it feeds both
 * `RunDetail.inferredCriteria` and the verdict's "N of M criteria were inferred
 * rather than stated in your ticket". A criterion resting on a page he chose is
 * not the grader's guess about his intent, so leaving it out here would raise
 * that number for a run in which he supplied MORE, not less.
 */
export function isStatedByOwner(assumption: Assumption): boolean {
  return (
    assumption.source === "ticket" ||
    assumption.source === "answered" ||
    assumption.source === "reference"
  );
}

export interface Assumption {
  readonly id: string;
  /** The criterion this records, or null for a ticket-level note. */
  readonly criterionId: string | null;
  readonly statement: string;
  readonly source: AssumptionSource;
  /**
   * Why it carries that source, in the owner's terms. For `ticket`, the
   * sentence they wrote, quoted, so they can recognise it. For `inferred`, the
   * rule that produced the label and what the ticket did give it to work with —
   * an inference that cannot justify itself is not reviewable, and an
   * unreviewable record is the same as no record.
   */
  readonly because: string;
}

/* -------------------------------------------------------------------------
 * TIER-0 GATES — the one kind of criterion this module must never reason about
 *
 * MEASURED DEFECT, `dashboard/results/calibration-4b/2026-07-29T09-42-34-574Z/
 * run/cal4b-correct-portfolio.verdict.md`. The scorer synthesises tier-0 gates
 * as criteria with no authored prose, so what arrives here is a criterion whose
 * id AND statement are both the bare string "GATE:suite-green". The overlap
 * tracer below ran over that string, found nothing in common with the ticket —
 * of course it did — and stamped it "INFERRED, not something you wrote — the
 * grader added this. It is the grader's guess about what your ticket implies".
 *
 * Every word of that is false. A tier-0 gate is not an inference about the
 * ticket; it is a fixed check that runs on every artefact whatever the ticket
 * says. {@link HOUSE_RULES} already says this for gates that DO carry authored
 * prose, by matching their statements. It cannot fire on a bare id, so the id
 * itself has to be the key — which is safe, because the id list is a public
 * constant rather than anything the sealed container produced.
 *
 * THE GATE IDS ARE NOT HELD OUT AND NAMING ONE IS NOT A LEAK. `ALL_GATE_IDS` is
 * exported from `bakeoff/src/scorer-protocol.ts` and the `GATE:` prefix is
 * reserved there. What may not render is a gate's `detail` or `evidenceRef` —
 * those are written by the container and quote assertions, so they can carry
 * held-out test titles. Naming WHICH gate failed is the discrimination the
 * verdict page was missing; printing what the gate SAID is the boundary.
 * ---------------------------------------------------------------------- */

/**
 * One fixed, owner-facing sentence per tier-0 gate, stating the FAILURE.
 *
 * They are written in the failing voice because that is the only place they
 * render: a gate that passed is not news. Keyed by the id and checked against
 * `ALL_GATE_IDS` in the test file, so a gate added upstream turns the suite red
 * instead of arriving on the owner's page as a machine id.
 *
 * NOTHING FROM THE CONTAINER MAY BE INTERPOLATED HERE. These are constants
 * authored before any build, which is what makes them renderable at all.
 */
export const GATE_LABELS: ReadonlyMap<string, string> = new Map([
  [
    GATE_IDS.suiteIntact,
    "The frozen acceptance suite was altered during the run, so nothing it reported can be trusted.",
  ],
  [
    GATE_IDS.noProtectedPathWrites,
    "Files that the run was not allowed to touch were written to.",
  ],
  [GATE_IDS.build, "The project does not build."],
  [GATE_IDS.typecheck, "The project does not typecheck."],
  [GATE_IDS.lint, "The project does not pass its own lint rules."],
  [GATE_IDS.boot, "The app does not start up and answer on its own address."],
  [GATE_IDS.routes, "At least one page the app declares does not answer when it is asked for."],
  [
    GATE_IDS.noStubMarkers,
    "Stub markers — TODO, FIXME, \"coming soon\" — were left in the shipped source.",
  ],
  [
    GATE_IDS.noRewardHackExploits,
    "The acceptance suite was tampered with rather than satisfied, so a green suite would have meant nothing.",
  ],
  [GATE_IDS.dataPresent, "The data the app says it ships is not there."],
  [
    GATE_IDS.screenshotsPresent,
    "No usable screenshot was captured, so there is no visual evidence of what was built.",
  ],
  [
    GATE_IDS.suiteGreen,
    "The frozen acceptance suite went red, and no single requirement accounts for it.",
  ],
]);

/**
 * Is this criterion id a tier-0 gate?
 *
 * The PREFIX decides, not membership of {@link GATE_LABELS}. `GATE:` is reserved
 * by the protocol, so an id carrying it is a gate even when this module has no
 * label for it yet — and treating an unlabelled gate as an ordinary criterion is
 * how it would get fabricated provenance again. The label table's job is prose;
 * the drift test is what keeps the two in step.
 */
export function isGateCriterionId(id: string): boolean {
  return id.startsWith(GATE_ID_PREFIX);
}

/** True for the record of a gate criterion. Ticket-level notes are never gates. */
export function isGateAssumption(assumption: Assumption): boolean {
  return assumption.criterionId !== null && isGateCriterionId(assumption.criterionId);
}

/**
 * The owner-facing sentence for a gate id.
 *
 * An id with no label says so IN ENGLISH rather than falling back to the id.
 * The fallback is not decoration: the drift test makes an unlabelled gate a
 * red suite, and if one ever reaches an owner anyway they get a sentence that
 * tells them the grader is incomplete instead of a symbol they cannot act on.
 */
export function gateLabel(id: string): string {
  return (
    GATE_LABELS.get(id) ??
    `A fixed check that runs on every artefact did not pass, and the grader has no ` +
      `description for it (${id}). That missing description is a grader defect: report it.`
  );
}

/** Why a gate carries `default`. Fixed prose: there is nothing here to trace. */
function gateReason(id: string): string {
  return (
    `a fixed check that runs on every artefact whatever the ticket says (${id}). ` +
    "It is not a guess about what you meant, so there is nothing here to correct."
  );
}

/* -------------------------------------------------------------------------
 * HOST-ROLLED-UP QUALITY IDS — the same defect as the tier-0 gates, one door
 * down, and NOT solvable the same way
 *
 * MEASURED, same 4B verdict file. `QUALITY:default_serif_font` reached the page
 * as its own machine id, stamped "INFERRED, not something you wrote — the
 * grader added this. It is the grader's guess about what your ticket implies".
 * Every word of that is false in the same way it was false for `GATE:*`: these
 * ids are minted by `summariseDomFindings` in `bakeoff/src/scorer.ts` out of the
 * container's own DOM observations, one per kind that fired. Nobody inferred
 * anything about the ticket.
 *
 * WHY THIS IS NOT JUST A SECOND `GATE_LABELS`. The gate table is checked at
 * RUNTIME against `ALL_GATE_IDS`, an exported constant, so a gate added upstream
 * turns the suite red. There is no equivalent constant here. The kinds live in
 * the `DomFindingKind` UNION and in a `known` array local to
 * `parseContainerResult`; neither is exported, and the two roll-ups that are not
 * DOM findings at all are bare string literals inside `summariseDomFindings`.
 * Copying ten ids into a list nothing can check is exactly the "second
 * uncheckable list" this file already refuses to grow.
 *
 * SO THE CHECKED SURFACE IS MAXIMISED RATHER THAN ABANDONED, in two parts:
 *
 *   1. {@link DOM_FINDING_LABELS} is typed `Record<DomFindingKind, string>`. A
 *      kind ADDED upstream fails to compile ("property is missing"); a kind
 *      REMOVED upstream fails to compile too (an object literal may not name a
 *      key the type does not have). That is a stricter check than the gates'
 *      runtime one, not a weaker one — it cannot be reached with the suite green.
 *
 *   2. The two non-DOM roll-ups below are UNCHECKED and are labelled as such.
 *      `QUALITY:non_blocking_exploit_pattern` and `QUALITY:scorer_infrastructure`
 *      are string literals in scorer.ts with no type behind them; nothing here
 *      can notice if they are renamed. What protects the owner in that case is
 *      {@link qualityRollupLabel}'s fallback, which says in English that the
 *      grader has no description for the id — a grader defect the owner can
 *      report, rather than a symbol they cannot act on.
 *
 * THE PREFIX, NOT THE TABLE, DECIDES WHAT IS A ROLL-UP. Same rule as
 * `isGateCriterionId`: an unlabelled roll-up is still a roll-up, and treating one
 * as an ordinary criterion is how it gets fabricated provenance again.
 * ---------------------------------------------------------------------- */

/**
 * `QUALITY:` — the prefix `summariseDomFindings` mints its criterion ids with.
 *
 * A SECOND SPELLING OF AN UPSTREAM LITERAL, said out loud because it is a real
 * cost. `scorer-protocol.ts` exports `GATE_ID_PREFIX` and exports no equivalent
 * for this one, so the string is repeated here rather than imported. If the
 * upstream prefix changes, this goes quiet — which is why the fallback in
 * {@link qualityRollupLabel} has to say something rather than nothing.
 */
export const QUALITY_ROLLUP_PREFIX = "QUALITY:";

/**
 * One owner-facing sentence per DOM observation kind.
 *
 * KEYED BY THE UNION ON PURPOSE — see the block comment above. They are written
 * in the OBSERVED voice, like {@link GATE_LABELS} and unlike an authored QUALITY
 * criterion, because that is the only place they render: an observation that did
 * not fire produces no criterion at all. `verdict.ts:renderNotes` therefore does
 * NOT prefix them with "not met:", which would negate a sentence that is already
 * negative.
 */
const DOM_FINDING_LABELS: Readonly<Record<DomFindingKind, string>> = Object.freeze({
  console_error: "The page logged errors to the browser console while it was being used.",
  unhandled_rejection: "Something the page started in the background failed, and nothing handled the failure.",
  same_origin_request_failed: "The page asked its own server for something and did not get it.",
  sealed_network_request_blocked:
    "The page tried to reach the open internet. The grader runs sealed, so the request was blocked — " +
    "anything the page needs has to ship with it.",
  image_natural_width_zero: "An image on the page never loaded: it takes up space and shows nothing.",
  horizontal_overflow: "The page scrolls sideways at one of the widths it was looked at.",
  default_serif_font:
    "The page renders in the browser's default serif font, so no typeface was chosen for it.",
  placeholder_text: "Placeholder text — lorem ipsum, \"your text here\" — is still on the page.",
});

/**
 * Every host-rolled-up QUALITY id this module can name.
 *
 * The DOM half is derived from the typed table, so it cannot drift from it. The
 * two entries after it are the unchecked ones; they are written out rather than
 * derived because there is nothing to derive them from.
 */
const QUALITY_ROLLUP_LABELS: ReadonlyMap<string, string> = new Map([
  ...Object.entries(DOM_FINDING_LABELS).map(
    ([kind, label]) => [`${QUALITY_ROLLUP_PREFIX}${kind}`, label] as const,
  ),
  // UNCHECKED, and deliberately so. Both are bare string literals in
  // `summariseDomFindings`; no type or constant upstream can be compared against
  // them. A rename upstream lands on the fallback below, which says so.
  [
    `${QUALITY_ROLLUP_PREFIX}non_blocking_exploit_pattern`,
    "Code that could rig a test suite was found outside the test files. It is reported and it did not " +
      "fail the run — the blocking version of this check is a separate one.",
  ],
  [
    `${QUALITY_ROLLUP_PREFIX}scorer_infrastructure`,
    "The grader itself hit a problem while scoring this run. That is the grader's failure and not your " +
      "artefact's: report it rather than changing code to satisfy it.",
  ],
]);

/** Is this criterion id a host roll-up of the container's own observations? */
export function isQualityRollupId(id: string): boolean {
  return id.startsWith(QUALITY_ROLLUP_PREFIX);
}

/** True for the record of a roll-up criterion. Ticket-level notes are never one. */
export function isQualityRollupAssumption(assumption: Assumption): boolean {
  return assumption.criterionId !== null && isQualityRollupId(assumption.criterionId);
}

/**
 * The owner-facing sentence for a host-rolled-up QUALITY id.
 *
 * THE FALLBACK IS THE LOAD-BEARING PART HERE, unlike {@link gateLabel} where a
 * drift test makes it nearly unreachable. Two of the ten ids are unchecked, so
 * this branch is genuinely reachable, and it has to leave the owner with
 * something they can act on: "the grader has no description for this" is a bug
 * report they can file. The bare id is not.
 */
export function qualityRollupLabel(id: string): string {
  return (
    QUALITY_ROLLUP_LABELS.get(id) ??
    `The grader recorded a quality observation it has no description for (${id}). It did not fail the ` +
      `run. The missing description is a grader defect: report it.`
  );
}

/** Why a roll-up carries `default`. Same shape as {@link gateReason}. */
function qualityRollupReason(id: string): string {
  return (
    `an observation the grader records on every artefact whatever the ticket says (${id}). ` +
    "It is reported and it never fails a run, so there is nothing here to correct."
  );
}

/**
 * Shared content tokens required before a criterion is called `ticket`-sourced.
 * Two, per the file header: one is vocabulary, two is a phrase.
 */
export const MIN_SHARED_CONTENT_TOKENS = 2;

/**
 * Function words. Carry no requirement in any ticket, in any domain.
 *
 * Includes the modals — shall, must, should, will — deliberately: acceptance
 * criteria are written in EARS notation ("the system shall ..."), so a modal is
 * the single most common word in a criteria set and the single least
 * informative. Matching on it would make every criterion resemble every ticket.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any",
  "are", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "cannot", "could", "did", "do", "does", "doing", "down", "during", "each",
  "either", "else", "ever", "every", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "hers", "him", "his", "how", "however", "i", "if", "in", "into",
  "is", "it", "its", "itself", "just", "least", "less", "many", "may", "me", "might", "more",
  "most", "much", "must", "my", "neither", "no", "nor", "not", "now", "of", "off", "on", "once",
  "only", "onto", "or", "other", "others", "our", "ours", "out", "over", "own", "per", "same",
  "shall", "she", "should", "so", "some", "still", "such", "than", "that", "the", "their",
  "theirs", "them", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "unless", "until", "up", "upon", "us", "via", "very", "was", "we", "were", "what",
  "when", "where", "whether", "which", "while", "who", "whom", "whose", "why", "will", "with",
  "within", "without", "would", "yet", "you", "your", "yours",
]);

/**
 * Words that are contentful in English and empty in THIS domain.
 *
 * The header explains the mechanism; this is the boundary. Two kinds of word
 * qualify, and nothing else may be added here:
 *   1. the act of delivering — build, make, create, add, implement, ship;
 *   2. the deliverable in the abstract — site, page, app, thing, feature.
 * Both appear in essentially every ticket, so their presence in a criterion is
 * evidence of nothing.
 *
 * WHAT MUST NEVER GO IN. A word naming what the artefact CONTAINS — project,
 * hero, contact, form, gallery, changelog. Those are the words that distinguish
 * one ticket from another, and suppressing one would push a criterion the owner
 * genuinely stated into INFERRED. That is the cheap error, but it is still an
 * error, and this list is the only place it can be introduced silently.
 */
const TICKET_BOILERPLATE: ReadonlySet<string> = new Set([
  "add", "app", "application", "build", "building", "built", "create", "created", "creating",
  "get", "give", "good", "implement", "implemented", "made", "make", "making", "need", "needed",
  "new", "nice", "page", "please", "product", "ship", "shipped", "site", "stuff", "thing",
  "use", "used", "using", "want", "web", "website", "work", "working", "would-like",
]);

/**
 * Lowercase, split on anything that is not a letter or digit, drop single
 * characters, and singularise.
 *
 * Singularisation is a plural rule and nothing more — "forms" to "form",
 * "matches" to "match". No -ing, -ed or -ation rules: a stemmer aggressive
 * enough to map "confirmation" to "confirm" also maps "station" to "st", and
 * every collision it invents lands on the side that marks an inference
 * owner-approved. Shallow is the safe direction here.
 */
function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map(singularise);
}

function singularise(word: string): string {
  // boxes / matches / dishes / buzzes -> box / match / dish / buzz
  if (word.length >= 6 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  // forms -> form. Never "class" -> "clas", never "is" -> "i".
  if (word.length >= 5 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Tokens that could carry a requirement: not a function word, not boilerplate.
 *
 * EXPORTED FOR `plan-question.ts`, AND THE EXPORT IS THE POINT RATHER THAN A
 * CONVENIENCE. The plan phase refuses a question whose two candidate criteria
 * differ only in words this filter drops — that is the entire mechanism that
 * stops "what colour scheme?" reaching the owner. Re-declaring the two lists
 * over there would give the refusal a second, drifting definition of "content",
 * and the header above says plainly that deleting either list turns the
 * negative control red. One list, one filter, two callers.
 *
 * Signature and behaviour unchanged by the export.
 */
export function contentTokens(text: string): readonly string[] {
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token) || TICKET_BOILERPLATE.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/**
 * The ticket sentence that best supports a match, quoted verbatim.
 *
 * Verbatim matters: the owner recognises their own sentence, and cannot
 * recognise a list of stemmed tokens. This is the difference between a record
 * they can act on and one they scroll past.
 */
function supportingSentence(ticket: string, shared: readonly string[]): string {
  const parts = ticket
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let best = ticket.trim();
  let bestHits = -1;
  for (const part of parts) {
    const tokens = new Set(tokenize(part));
    const hits = shared.filter((t) => tokens.has(t)).length;
    if (hits > bestHits) {
      best = part;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * The house rules: criteria that exist because every artefact is checked for
 * them, not because anyone read the ticket.
 *
 * These mirror the Tier-0 gates `SealedScorerGate` already emits. The patterns
 * are deliberately tight — anchored on gate phrasing, never on a bare keyword —
 * because a loose pattern is a quiet failure: it would route a genuine
 * inference to `default`, and `default` is the one label that tells the owner
 * "nothing to review here".
 */
const HOUSE_RULES: readonly { readonly gate: string; readonly rule: string; readonly pattern: RegExp }[] = [
  {
    gate: "GATE:build",
    rule: "the artefact must build",
    pattern: /\bnpm run build\b|\bbuilds? (?:succeed|pass|complete|is clean|exits? 0)/i,
  },
  {
    gate: "GATE:typecheck",
    rule: "the artefact must typecheck",
    pattern: /\btype-?check|\btsc\b|\btype errors?\b/i,
  },
  { gate: "GATE:lint", rule: "the artefact must lint clean", pattern: /\bes-?lint\b|\blints? (?:clean|pass)/i },
  {
    gate: "GATE:no-stub-markers",
    rule: "no stub markers may ship",
    pattern: /\bTODO\b|\bFIXME\b|\bstub markers?\b|\bcoming soon\b|\bnot implemented\b/i,
  },
  {
    gate: "GATE:no-reward-hack-exploits",
    rule: "the suite may not be gamed",
    pattern: /\breward[- ]hack|\bexploits?\b|\bassertion-free\b/i,
  },
  {
    gate: "GATE:boot",
    rule: "the artefact must boot",
    pattern: /\bboots? (?:cleanly|without)|\bstarts? without (?:any )?errors?\b|\bconsole errors?\b/i,
  },
  {
    gate: "GATE:routes",
    rule: "every route must respond",
    pattern: /\b(?:all|every) routes?\b|\breturns? (?:a )?200\b|\bno 404s?\b/i,
  },
  {
    gate: "GATE:screenshots-present",
    rule: "evidence must be captured",
    pattern: /\bscreenshots?\b/i,
  },
  {
    gate: "GATE:no-protected-path-writes",
    rule: "protected paths may not be written",
    pattern: /\bprotected paths?\b/i,
  },
];

function houseRuleFor(statement: string): { readonly gate: string; readonly rule: string } | null {
  for (const entry of HOUSE_RULES) {
    if (entry.pattern.test(statement)) return { gate: entry.gate, rule: entry.rule };
  }
  return null;
}

/* -------------------------------------------------------------------------
 * WHAT HE ANSWERED — the plan phase's pairs, and the rule that keeps the label
 * honest
 *
 * MEASURED DEFECT (2026-08-02, fixture `run-2026-07-30T20-16-40-242Z-052c6e02`,
 * its own ticket and its own 16 criteria). Three questions answered by the
 * owner moved `inferredCriteria` 16 -> 16 — not one criterion changed label,
 * because this function took no pairs and there was no fourth source for one to
 * land on. The whole justification for interrupting him is that this number
 * falls when he answers; it did not fall, so the interruption bought nothing
 * measurable.
 *
 * THE OBVIOUS CHEAT, NAMED SO IT CAN BE REFUSED. Relabelling criteria because a
 * plan block exists somewhere in the brief — or matching them against the
 * QUESTIONS, which are the machine's own words — moves the number without
 * improving anything, and it moves it in the direction that HIDES an inference.
 * That is the false-pass shape this whole module exists to prevent, reintroduced
 * by the module built to prevent it.
 *
 * SO THE LINK MUST RUN FROM A SPECIFIC ANSWER TO A SPECIFIC CRITERION, and the
 * rule is two conditions, not one:
 *   1. the criterion shares at least {@link MIN_SHARED_CONTENT_TOKENS} content
 *      tokens with the PAIR — his answer plus the question it answers; and
 *   2. AT LEAST ONE of those shared tokens is his answer's own.
 *
 * WHY THE PAIR AND NOT THE ANSWER ALONE. Real answers are elliptical: asked "how
 * many projects?" he types "four", which carries one content token against a
 * threshold of two. The question supplies the subject his answer omits, and it
 * is legitimate context precisely because he answered THAT question.
 *
 * WHY CONDITION 2 IS NOT OPTIONAL. Without it, "should the nav be sticky?" —
 * "yes" would stamp a nav criterion as his, on the strength of the machine's own
 * sentence; a "no" would stamp it just as firmly. Condition 2 also keeps the
 * record CHECKABLE BY EYE, which is the same argument that makes the `ticket`
 * branch quote only the words its quoted sentence actually contains: the reason
 * names the words to look for, and he must be able to find at least one of them
 * in his own reply. A record whose one invited check fails is worse than none.
 *
 * WHAT IS NOT HERE. Declined and expired questions produce no pair at all —
 * `plan-state.ts:answeredPairs` and `plan-brief.ts:answeredInOwnerWords` both
 * refuse to emit one — because their recorded default is the house's guess. If
 * declining moved this number, declining everything would be the cheapest way to
 * a clean report.
 * ---------------------------------------------------------------------- */

/**
 * One question the owner answered, in HIS words.
 *
 * `answer` MUST BE THE OWNER'S OWN TEXT, not the seat's paraphrase of it.
 * `PlanAnswer` carries both — `text` is the recorded wording and `quoted` is the
 * span of his turn it rests on, with `paraphrased` saying which is which — and
 * crediting a criterion to a sentence the machine wrote would be this module's
 * own defect one level down. `plan-brief.ts:answeredInOwnerWords` is the one
 * place that resolves it; this type only records the contract.
 */
export interface AnsweredQuestion {
  /** The question as it was put to him. Context only: it can never carry a match alone. */
  readonly question: string;
  /** His reply, verbatim. */
  readonly answer: string;
}

interface AnsweredSupport {
  readonly pair: AnsweredQuestion;
  /** Shared with the pair, his answer's words first. Every one is in the criterion. */
  readonly shared: readonly string[];
  /** The subset he himself typed. Non-empty, or there is no support at all. */
  readonly fromAnswer: readonly string[];
}

/**
 * The answer that best supports this criterion, or null.
 *
 * BEST = most of HIS words shared, then most shared overall, then asked first.
 * The first key is the deliberate one: between an answer that shares two of his
 * words and one that shares one of his and three of the question's, the record
 * should quote the reply that actually says it. Ties break toward the earlier
 * question so the choice is stable across runs rather than dependent on map
 * ordering — the same reason `supportingSentence` scans in document order.
 */
function answeredSupportFor(
  statement: string,
  answered: readonly AnsweredQuestion[],
): AnsweredSupport | null {
  const criterionTokens = contentTokens(statement);
  let best: AnsweredSupport | null = null;
  for (const pair of answered) {
    const answerTokens = new Set(contentTokens(pair.answer));
    const questionTokens = new Set(contentTokens(pair.question));
    const shared = criterionTokens.filter((t) => answerTokens.has(t) || questionTokens.has(t));
    const fromAnswer = shared.filter((t) => answerTokens.has(t));
    // BOTH CONDITIONS, AND THE SECOND IS THE ONE THAT REFUSES THE CHEAT. A pair
    // whose only overlap is the question's wording is the machine agreeing with
    // itself.
    if (shared.length < MIN_SHARED_CONTENT_TOKENS || fromAnswer.length === 0) continue;
    const candidate: AnsweredSupport = {
      pair,
      // His words lead the list, because his words are what he can check.
      shared: [...fromAnswer, ...shared.filter((t) => !answerTokens.has(t))],
      fromAnswer,
    };
    if (
      best === null ||
      candidate.fromAnswer.length > best.fromAnswer.length ||
      (candidate.fromAnswer.length === best.fromAnswer.length && candidate.shared.length > best.shared.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Why a criterion carries `answered`, in the owner's terms.
 *
 * QUOTES BOTH SIDES AND SAYS WHICH WORDS ARE HIS. The question alone would let
 * him think the dashboard credited him with its own sentence; his answer alone
 * would leave "four" floating with no subject. The words the question
 * contributed are named separately rather than merged, so the one check this
 * record invites — read your reply, find the words — is one he can actually run.
 *
 * THE WORDS PRINT AS THE TRACER SEES THEM, NOT AS HE TYPED THEM, and that is a
 * real if minor cost: `singularise` maps "entries" to "entrie", so that is what
 * the list says. His reply still CONTAINS every printed word as a prefix — which
 * is exactly what the test asserts, and the same thing the `ticket` branch has
 * always done — so the check by eye survives. Printing the verbatim span instead
 * would mean carrying each token's original offset through `contentTokens`, and
 * that is a change to the shared filter `plan-question.ts` also depends on.
 */
function answeredReason(support: AnsweredSupport): string {
  const fromQuestion = support.shared.filter((t) => !support.fromAnswer.includes(t));
  const context =
    fromQuestion.length === 0
      ? ""
      : ` The question supplied the rest of the wording: ${fromQuestion.join(", ")}.`;
  return (
    `you settled this before anything was frozen. The dashboard asked: "${oneLine(support.pair.question)}" ` +
    `and you answered: "${oneLine(support.pair.answer)}" — your own words in this criterion: ` +
    `${support.fromAnswer.join(", ")}.${context}`
  );
}

/** Newlines flattened so a multi-line answer cannot reshape the record's bullet. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------
 * WHAT WAS READ OFF THE PAGE HE POINTED AT — the fifth source, and the reason
 * it cannot be "a reading exists"
 *
 * MEASURED DEFECT (2026-08-04). `AssumptionSource` gained `reference` and
 * `isStatedByOwner` gained its third case, and `grep -rn 'source: "reference"'
 * dashboard/server/src/` returned nothing outside the tests. So the bucket was
 * set by nothing: every criterion the spec seat authored out of a captured
 * motion block came back `inferred`, `RunDetail.inferredCriteria` went UP for a
 * run in which the owner had supplied more, and `orchestrator.ts#recordAssump-
 * tions` escalated the run log to `warn` about it.
 *
 * WHY THE TRACER CANNOT FIND IT ON ITS OWN. `#recordAssumptions` feeds this
 * module `ticketProse(stripPlanBlock(ticket.brief))`, and `ticketProse` cuts the
 * motion block back off — deliberately, because `classifySurface` reads the same
 * brief and a captured vocabulary there decides the delegation lane. The reading
 * therefore arrives BESIDE the prose, exactly as the plan phase's pairs do, and
 * for the same reason: folding it into the traced text would credit the owner
 * with the dashboard's own sentences.
 *
 * THE OBVIOUS CHEAT, NAMED SO IT CAN BE REFUSED — it is `answeredSupportFor`'s,
 * one door down. Relabelling a criterion because a reading EXISTS would drive
 * `inferredCriteria` toward zero and make the number mean nothing; it moves in
 * the direction that HIDES an inference, which is the false-pass shape this
 * module exists to prevent. So the rule is two conditions, not one:
 *   1. the criterion shares at least {@link MIN_SHARED_CONTENT_TOKENS} content
 *      tokens with ONE observation; and
 *   2. at least one of those shared tokens is part of what was MEASURED.
 *
 * WHY CONDITION 2 IS NOT OPTIONAL, and it is the whole of this branch. An
 * observation line is half measurement and half the dashboard's own prose:
 * `motion-brief.ts:FAMILY_PROSE` writes "revealed once on scroll into view",
 * which is four content tokens nobody read off the page. Without condition 2 the
 * criterion "content is revealed as it scrolls into view, animating smoothly"
 * shares four words with that line and is stamped as the owner's — the machine
 * agreeing with itself, which is precisely what the `answered` branch refuses
 * about a question's wording.
 * ---------------------------------------------------------------------- */

/**
 * One thing a reference page was observed to do.
 *
 * `line` IS QUOTED VERBATIM IN THE RECORD and is the same string the spec seat
 * read in the brief, so the one check this record invites — find this line in
 * the block, find these words in the criterion — is one the owner can run.
 *
 * `measured` IS RAW TEXT, NOT TOKENS, and that is deliberate: {@link
 * contentTokens} is applied to it HERE, so "what counts as a content word" keeps
 * the single definition this file's header says the negative controls depend on.
 * A producer that pre-tokenized would be a second, drifting copy of that filter.
 *
 * WHAT MAY GO IN `measured`: only what was read off the page — the element role,
 * the properties that changed, the durations, the easing family, a ratio. WHAT
 * MAY NOT: the family's prose, the block's framing sentences, anything the
 * dashboard wrote. Putting a word of the dashboard's own in here re-opens the
 * cheat condition 2 exists to close.
 */
export interface ReferenceObservation {
  /** The observation as the spec seat read it. Quoted, never re-worded. */
  readonly line: string;
  /** What was read off the page, in the reading's own spelling. */
  readonly measured: readonly string[];
}

/**
 * A page the owner named as a reference, and what was observed on it.
 *
 * PRODUCED BY `motion-brief.ts:motionReferenceReading` TODAY and typed here
 * rather than there so this module does not import a renderer that pulls in the
 * motion types. Nothing about the shape is motion-specific: a future capture
 * that reads something else off a page he chose files under the same source and
 * obeys the same two conditions.
 *
 * A READING WITH NO OBSERVATIONS IS NOT THE SAME AS NO READING, and both reach
 * the same answer here — nothing can be credited to either — which is the
 * distinction `ticket-refs.ts:manifestMotion` insists on keeping upstream. "A
 * page was read and nothing moved" is evidence about the page; it is evidence
 * for no criterion.
 */
export interface ReferenceReading {
  /** The page's address, named in the record so he can go and look. */
  readonly url: string;
  readonly observations: readonly ReferenceObservation[];
}

interface ReferenceSupport {
  readonly observation: ReferenceObservation;
  /** Shared with the observation, the measured words first. */
  readonly shared: readonly string[];
  /** The subset that was actually measured. Non-empty, or there is no support. */
  readonly fromMeasurement: readonly string[];
}

/**
 * The observation that best supports this criterion, or null.
 *
 * BEST = most MEASURED words shared, then most shared overall, then first in the
 * reading. The first key is `answeredSupportFor`'s and is deliberate for the
 * same reason: between an observation sharing two measured words and one sharing
 * one measured word and three of the dashboard's, the record should quote the
 * line that actually says it. The reading's order is stable — `normaliseMotion`
 * sorts it — so the final tie-break is stable across runs too.
 *
 * WHAT IT DOES NOT DO: it does not check that the criterion is ABOUT the thing
 * measured, only that it carries its words. "Cards fade in opacity over 500ms"
 * and "cards must NOT fade in opacity over 500ms" trace identically. The
 * asymmetry argument in this file's header is what makes that acceptable —
 * both are the owner reviewing a line he can recognise — and it is stated here
 * rather than implied because it is a real limit.
 *
 * IT IS SPELLING-SENSITIVE, AND THAT IS THE CHEAP DIRECTION. `500ms` in the
 * reading does not match `500 ms` in a criterion: the tokenizer splits on the
 * space and neither half survives as the same token. Widening it by emitting
 * alternate spellings would put the bare token `500` in the measured set, where
 * any criterion mentioning any 500 of anything would match it — a manufactured
 * overlap, which this file's header calls the first error and not the second.
 *
 * AND THE TOKEN PRINTS AS `500m`, NOT `500ms`. {@link singularise} takes the
 * trailing `s` off any five-character-or-longer word, so the duration reads like
 * a length in metres in the record's "measured wording" list. It is the same
 * cost {@link answeredReason} already accepts — every printed token is still a
 * prefix of what the quoted line contains, so the check by eye survives — and
 * fixing it properly means carrying each token's original offset through
 * `contentTokens`, which `plan-question.ts` also depends on.
 */
function referenceSupportFor(
  statement: string,
  reading: ReferenceReading | null,
): ReferenceSupport | null {
  if (reading === null) return null;
  const criterionTokens = contentTokens(statement);
  let best: ReferenceSupport | null = null;
  for (const observation of reading.observations) {
    const lineTokens = new Set(contentTokens(observation.line));
    const measuredTokens = new Set(observation.measured.flatMap((value) => contentTokens(value)));
    const shared = criterionTokens.filter((t) => lineTokens.has(t) || measuredTokens.has(t));
    const fromMeasurement = shared.filter((t) => measuredTokens.has(t));
    // BOTH CONDITIONS, AND THE SECOND IS THE ONE THAT REFUSES THE CHEAT —
    // watched red on 2026-08-04 with only the first in place: the criterion
    // "content is revealed as it scrolls into view, animating smoothly" came
    // back `reference` on the strength of four words this repository wrote into
    // `FAMILY_PROSE`, with nothing measured behind any of them.
    if (shared.length < MIN_SHARED_CONTENT_TOKENS || fromMeasurement.length === 0) continue;
    const candidate: ReferenceSupport = {
      observation,
      // The measured words lead, because those are the ones he can check
      // against the reading rather than against the dashboard's phrasing.
      shared: [...fromMeasurement, ...shared.filter((t) => !measuredTokens.has(t))],
      fromMeasurement,
    };
    if (
      best === null ||
      candidate.fromMeasurement.length > best.fromMeasurement.length ||
      (candidate.fromMeasurement.length === best.fromMeasurement.length &&
        candidate.shared.length > best.shared.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Why a criterion carries `reference`, in the owner's terms.
 *
 * NAMES THE PAGE AND QUOTES THE LINE, for the reason `answeredReason` quotes
 * both sides: the address alone would credit him with a page rather than a fact,
 * and the line alone would leave him unable to go and look. The words are
 * printed as the tracer sees them — `singularise` and all, the same minor cost
 * the `answered` branch already accepts — so every printed word is still findable
 * in the quoted line as a prefix.
 */
function referenceReason(support: ReferenceSupport, url: string): string {
  return (
    `read off the page you gave as a motion reference (${url}). Its reading says: ` +
    `"${oneLine(support.observation.line)}" — the measured wording this criterion carries: ` +
    `${support.fromMeasurement.join(", ")}.`
  );
}

/**
 * One record per criterion, in criteria order. Never fewer — a criterion with no
 * record is an inference the owner cannot see.
 *
 * `answered` DEFAULTS TO EMPTY, and that default is a control rather than a
 * convenience: every caller that predates the plan phase — `calibration/
 * grade-fixture.ts` among them — keeps producing byte-identical output, so a
 * change in any of their numbers is attributable to this change and to nothing
 * else. `spec-assumptions.answered.test.ts` measures the same fixture with and
 * without pairs for exactly that reason.
 *
 * `reference` DEFAULTS TO NULL ON THE SAME ARGUMENT. A run with no motion
 * reference — which is every run before 2026-08-04 and most runs after it —
 * produces the record it produced yesterday, byte for byte, and there is a test
 * asserting the two calls are deep-equal.
 */
export function extractAssumptions(
  ticket: string,
  criteria: readonly AcceptanceCriterion[],
  answered: readonly AnsweredQuestion[] = [],
  reference: ReferenceReading | null = null,
): readonly Assumption[] {
  const ticketTokens = new Set(contentTokens(ticket));
  const ticketVocabulary = [...ticketTokens];

  return criteria.map((criterion, index) => {
    const base = { id: `A-${index + 1}`, criterionId: criterion.id, statement: criterion.statement };

    // BEFORE ANY TRACING. A tier-0 gate is not an inference about the ticket, so
    // the overlap heuristic must never see it — running it and discarding the
    // answer would leave the fabricated-provenance path one edit away from
    // coming back. The statement is replaced too: what arrives is the bare id.
    if (isGateCriterionId(criterion.id)) {
      return {
        ...base,
        statement: gateLabel(criterion.id),
        source: "default" as const,
        because: gateReason(criterion.id),
      };
    }

    // AND BEFORE ANY TRACING, for the same reason. A `QUALITY:*` id is minted by
    // the host from the container's own observations; it is not an inference
    // about the ticket, and the tracer running over the string
    // "QUALITY:default_serif_font" found no overlap — of course it did — and
    // stamped it "INFERRED, not something you wrote". Routing on the PREFIX
    // means an id this module has no label for is still kept away from the
    // heuristic; `qualityRollupLabel` says so in English.
    if (isQualityRollupId(criterion.id)) {
      return {
        ...base,
        statement: qualityRollupLabel(criterion.id),
        source: "default" as const,
        because: qualityRollupReason(criterion.id),
      };
    }

    const shared = contentTokens(criterion.statement).filter((t) => ticketTokens.has(t));

    if (shared.length >= MIN_SHARED_CONTENT_TOKENS) {
      // Credit only the words the QUOTED sentence actually contains. A real
      // ticket is several sentences; the support for one criterion is usually
      // spread across them, and listing all of it beside a single quotation
      // tells the owner they wrote "hero" in a sentence that does not contain
      // it. The one check this record invites — read the quote, find the words
      // — would then fail, and a record that cannot be checked by eye is the
      // same as no record.
      const sentence = supportingSentence(ticket, shared);
      const inSentence = new Set(tokenize(sentence));
      const quotedShared = shared.filter((t) => inSentence.has(t));
      return {
        ...base,
        source: "ticket" as const,
        because: `you wrote: "${sentence}" — shared wording: ${quotedShared.join(", ")}.`,
      };
    }

    const house = houseRuleFor(criterion.statement);
    if (house !== null) {
      return {
        ...base,
        source: "default" as const,
        because:
          `house rule, not your ticket: ${house.rule}. It is checked on every run ` +
          `whatever the ticket says (${house.gate}), so there is nothing here to correct.`,
      };
    }

    /*
     * AFTER THE HOUSE RULES, AND NOT BEFORE THEM — the one ordering decision in
     * this function that changes a number, and it was MEASURED WRONG FIRST.
     * Placed above the house block (as it was, with a comment claiming the
     * opposite), the criterion "Every route shall return a 200" against the pair
     * "should every route answer 200?" / "yes, every route must answer 200"
     * came back `answered` rather than `default` — verified 2026-08-02 before
     * the block was moved.
     *
     * WHY THAT MATTERS RATHER THAN BEING A TIE. `countInferredAssumptions` counts
     * `default` and excludes `answered`, so relabelling a house rule this way
     * drops the number for a criterion that is checked WHATEVER he says — the
     * dashboard moving its own score by choosing what to ask about. `ticket`
     * still outranks the house block above, and the asymmetry is deliberate: he
     * volunteered that sentence, whereas the question here was the machine's.
     */
    const support = answeredSupportFor(criterion.statement, answered);
    if (support !== null) {
      return { ...base, source: "answered" as const, because: answeredReason(support) };
    }

    /*
     * BELOW `ticket`, BELOW THE HOUSE RULES, AND BELOW `answered` — three
     * orderings, each of which changes a number, and none of them a tie.
     *
     *   BELOW `ticket`: a criterion he typed out himself, which the captured
     *   page also happens to describe, is HIS SENTENCE. Crediting the page
     *   instead would move a line he can edit into a bucket he cannot.
     *
     *   BELOW THE HOUSE RULES: `countInferredAssumptions` counts `default` and
     *   excludes `reference`, so a house rule relabelled here would drop the
     *   number for a check that runs whatever the ticket says — the dashboard
     *   moving its own score by what it happened to capture.
     *
     *   BELOW `answered`: his reply is his own words; a reading is a measurement
     *   he never saw. Both are his, and when both fit, the record should quote
     *   the one he can recognise.
     */
    const fromReference = referenceSupportFor(criterion.statement, reference);
    if (fromReference !== null && reference !== null) {
      return { ...base, source: "reference" as const, because: referenceReason(fromReference, reference.url) };
    }

    return { ...base, source: "inferred" as const, because: inferenceReason(shared, ticketVocabulary) };
  });
}

/**
 * Cap on the ticket vocabulary quoted back in an inference reason. The point of
 * quoting it is "here is what the grader had to work with"; past a handful of
 * words that stops being an argument and becomes a word cloud, and a record the
 * owner skims is a record that does not correct anything.
 */
const MAX_VOCABULARY_QUOTED = 8;

function inferenceReason(shared: readonly string[], ticketVocabulary: readonly string[]): string {
  const quoted = ticketVocabulary.slice(0, MAX_VOCABULARY_QUOTED).join(", ");
  const more = ticketVocabulary.length - MAX_VOCABULARY_QUOTED;
  const vocabulary =
    ticketVocabulary.length === 0
      ? "your ticket carried no distinctive words at all, so every criterion in this run is a guess."
      : `the distinctive words your ticket gave it were: ${quoted}${more > 0 ? ` (+${more} more)` : ""}.`;

  if (shared.length === 0) {
    return (
      "the grader added this — nothing you wrote appears in it. " +
      `It is the grader's guess about what your ticket implies, and ${vocabulary}`
    );
  }
  return (
    `the grader added this. It shares only "${shared.join(", ")}" with your ticket, and one ` +
    "word in common is a coincidence of vocabulary rather than a requirement you stated; " +
    `${MIN_SHARED_CONTENT_TOKENS} are needed. Otherwise ${vocabulary}`
  );
}

/**
 * The record the owner reads.
 *
 * INFERRED LEADS, always, and the ordering is the point of the document rather
 * than a formatting preference. The criteria traced to the ticket need no
 * review — the owner already agreed to those by typing them. The inferences are
 * the ones that can be wrong in the direction nobody notices, so they go where
 * someone skimming a file at breakfast will actually land.
 *
 * Every section header is printed even when empty. "INFERRED — none" is a real
 * and reassuring result; a missing heading is indistinguishable from a renderer
 * that dropped the section.
 */
export function renderAssumptions(a: readonly Assumption[]): string {
  const inferred = a.filter((x) => x.source === "inferred");
  const defaults = a.filter((x) => x.source === "default");
  const fromTicket = a.filter((x) => x.source === "ticket");
  const answered = a.filter((x) => x.source === "answered");
  const fromReference = a.filter((x) => x.source === "reference");

  const lines: string[] = [
    "# What the grader assumed",
    "",
    "These are the criteria this run was actually graded against. Anything wrong",
    "here is a false pass or a wasted fix round waiting to happen, and the cheapest",
    "correction is to the TICKET rather than to the code.",
    "",
    // THE FOURTH FIGURE IS PRINTED EVEN AT ZERO, like every section heading
    // below and for the same reason: "0 answered" on a run nobody was asked is a
    // true and readable statement, and a figure that appears only when it is
    // non-zero is indistinguishable from a renderer that dropped it. It is
    // appended rather than inserted so the sentence the owner already scans for
    // ("Of 16 criteria: 15 inferred by the grader…") reads the same up to the
    // comma.
    // THE FIFTH FIGURE IS A SEPARATE SENTENCE, not a fifth clause, and that is a
    // compatibility decision rather than a stylistic one: `assumptions-wiring.
    // test.ts:355` and `assumptions-answered.test.ts:257` both anchor on the
    // full stop after "when the dashboard asked", and moving it would redden two
    // assertions about a number this change does not touch.
    `Of ${a.length} criteria: ${inferred.length} inferred by the grader, ` +
      `${defaults.length} house defaults, ${fromTicket.length} traced to words you wrote, ` +
      `${answered.length} answered by you when the dashboard asked. ` +
      `${fromReference.length} read from the page you referenced.`,
    "",
    section("INFERRED — the grader's guesses. READ THESE FIRST.", inferred),
    section("ANSWERED BY YOU — you settled these before anything was frozen.", answered),
    // AFTER `ANSWERED` AND NOT BESIDE `INFERRED`: the document's order is the
    // owner's reading order, and these need no review from him in the way an
    // inference does — he chose the page they were read off.
    section("READ FROM THE PAGE YOU REFERENCED — measured, not guessed.", fromReference),
    section("HOUSE DEFAULTS — checked on every run, nothing to correct.", defaults),
    section("FROM YOUR TICKET — you already asked for these.", fromTicket),
  ];
  return lines.join("\n");
}

function section(heading: string, entries: readonly Assumption[]): string {
  const body =
    entries.length === 0
      ? "_none_\n"
      : entries
          .map((e) => `- **${e.criterionId ?? "ticket-level"}** — ${e.statement}\n  - why: ${e.because}\n`)
          .join("");
  return `## ${heading}\n\n${body}`;
}
