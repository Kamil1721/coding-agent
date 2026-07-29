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
 */
export type AssumptionSource = "ticket" | "inferred" | "default";

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

/** Tokens that could carry a requirement: not a function word, not boilerplate. */
function contentTokens(text: string): readonly string[] {
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

/**
 * One record per criterion, in criteria order. Never fewer — a criterion with no
 * record is an inference the owner cannot see.
 */
export function extractAssumptions(
  ticket: string,
  criteria: readonly AcceptanceCriterion[],
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

  const lines: string[] = [
    "# What the grader assumed",
    "",
    "These are the criteria this run was actually graded against. Anything wrong",
    "here is a false pass or a wasted fix round waiting to happen, and the cheapest",
    "correction is to the TICKET rather than to the code.",
    "",
    `Of ${a.length} criteria: ${inferred.length} inferred by the grader, ` +
      `${defaults.length} house defaults, ${fromTicket.length} traced to words you wrote.`,
    "",
    section("INFERRED — the grader's guesses. READ THESE FIRST.", inferred),
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
