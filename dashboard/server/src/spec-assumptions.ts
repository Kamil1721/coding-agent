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
    const shared = contentTokens(criterion.statement).filter((t) => ticketTokens.has(t));
    const base = { id: `A-${index + 1}`, criterionId: criterion.id, statement: criterion.statement };

    if (shared.length >= MIN_SHARED_CONTENT_TOKENS) {
      return {
        ...base,
        source: "ticket" as const,
        because:
          `you wrote: "${supportingSentence(ticket, shared)}" ` +
          `— shared wording: ${shared.join(", ")}.`,
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
