/**
 * ticket-title.ts — the short label a run is called on screen, derived from the
 * ticket's own words. Pure, synchronous, no model call and no network.
 *
 * WHAT WAS ON SCREEN AND WHY IT WAS WRONG. The run chip rendered
 * `run.ticketTitle` into a 24px heading in a ~340px box with CSS `truncate`, and
 * the owner's ticket came out as `I want you to make a copy of t…` — four words
 * of throat-clearing, then a cut mid-word. Nothing there is wrong exactly; every
 * character is the owner's. It is just that the first thirty characters of a
 * request are almost never the subject of the request, so the one piece of
 * display type on the canvas was spending itself on "I want you to".
 *
 * WHAT THE INPUT ACTUALLY IS, because it changes the rules. `RunSummary.
 * ticketTitle` is NOT the ticket. The server already reduced the brief with
 * `titleFromBrief` (`server/src/ticket.ts`): first non-empty line, markdown
 * heading markers stripped, capped at 80 characters with U+2026 appended, and
 * the literal string "Untitled ticket" when the brief has no words in it. So the
 * text arriving here is one line, already lossy, and may end in a fragment of a
 * word. This function is a SECOND reduction on top of that, and the original of
 * what it reduced has to stay reachable — see `ticketTooltip` below, and the
 * ticket tab in `canvas/sheet.tsx`, which renders `run.ticketText` verbatim.
 *
 * WHY WORDS AND NOT CHARACTERS. A character cap is what produced `copy of t…`.
 * Every cut here lands on a whitespace boundary, so the label is always made of
 * whole words the owner typed — with exactly one exception, the pathological
 * single token longer than `MAX_TOKEN_CHARS` (a 300-character URL path, a hash,
 * a base64 blob), which is clamped because a label cannot be a paragraph. That
 * exception is named rather than hidden.
 *
 * WHAT THIS IS NOT. It is not a summariser. The exact claim, which is the claim
 * `tests/ticket-title.unit.spec.ts` sweeps over ~180 inputs: every token of the
 * output is a WHOLE word of the input, or the host of a link in it, in the
 * input's own order, plus one capital letter and one ellipsis. Nothing is
 * written, nothing is reordered, no subject is inferred. That restriction is the
 * whole safety argument — a label that paraphrases can be wrong about a run, and
 * a wrong run name is worse than an ugly one. "Summarise" in the owner's request
 * is answered by DELETION, not by generation.
 *
 * WHAT IT DOES NOT COVER, measured and stated:
 *   - A ticket whose first line is boilerplate and whose subject is on line
 *     three still gets the boilerplate. `titleFromBrief` has already thrown the
 *     rest away before this function sees anything.
 *   - A lowercase command word at the front is capitalised: `npm test should
 *     run cold` becomes `Npm test should run cold`. An allowlist of ~10 command
 *     names was rejected — it would be wrong about the eleventh, and the damage
 *     is cosmetic.
 *   - The filler table below is short on purpose. Every entry is a chance to eat
 *     a word that carried meaning, so it covers request openers ("I want you
 *     to", "please", "can you") and nothing cleverer.
 *   - A label has to contain a letter or a digit in SOME script, so a ticket
 *     written entirely in emoji comes back as `UNTITLED_LABEL`. That is a real
 *     loss and it is taken knowingly: the same rule is what stops `!!!` from
 *     becoming a run's name.
 *   - It does not hoist a URL out of a discarded tail. `Copy this site, see
 *     https://example.com/pricing` keeps the clause and loses the host, because
 *     the alternative is asserting that "this site" means that URL, and a label
 *     naming the WRONG site is a lie the reader cannot detect.
 *
 * COST. A handful of regexes over one line of text — 80 characters at most when
 * the input came from `titleFromBrief` — once per run row. It is not memoised
 * because memoising it would cost more than running it.
 */

/**
 * What a ticket with no words in it is called.
 *
 * Deliberately the same string the server produces for an empty brief
 * (`titleFromBrief`), so the two places that can name an empty ticket do not
 * invent two different names for it. It is duplicated rather than imported: the
 * client does not import from `server/`, and this is a display string, not a
 * contract.
 */
export const UNTITLED_LABEL = "Untitled ticket";

/**
 * Most words a label may carry. Six is a phrase and not a sentence: enough for
 * "Fix the spec-seat abort path", short enough to read at a glance in a list.
 */
export const MAX_LABEL_WORDS = 6;

/**
 * Soft character budget: words stop being added once the label would pass it,
 * so six SHORT words fit and six long ones do not. The first word is always
 * kept whatever its length — a label of nothing is not an improvement.
 *
 * WHERE 30 COMES FROM, AND HOW SOFT IT IS. The chip is
 * `w-[min(360px,calc(100vw-32px))]` with `px-2.5`, so ~340px of content, and the
 * heading is the 24px `text-title` rung at `-0.015em`. At the ~0.5em average
 * advance the run-hud docblock already assumes, that is ~29 characters. It is an
 * ESTIMATE — nothing in this tree measures text — so CSS `truncate` stays on the
 * heading as the backstop. The difference is that a clip now lands on a label
 * that is already whole words, instead of on `copy of t…`.
 */
export const MAX_LABEL_CHARS = 30;

/** Longest single token kept whole; the one place a mid-word cut survives. */
export const MAX_TOKEN_CHARS = 28;

/**
 * Openers stripped from the front, applied repeatedly (a real ticket opens
 * "Please can you…"). Each is anchored and case-insensitive.
 *
 * `stripFiller` refuses any strip that would empty the line: "Please" on its own
 * is a bad ticket, but "Please" is a better label for it than "".
 */
const FILLER: readonly RegExp[] = [
  // "Hi,"/"Hey —" — a greeting, with whatever punctuation followed it.
  /^(?:hi|hey|hello)\b[\s,.!:;-]*/i,
  /^(?:please|pls|kindly)\s+/i,
  // "Can you", "Could you please", "Would you", "Will you" (+ "we").
  /^(?:can|could|would|will)\s+(?:you|u|we)\s+(?:please\s+)?/i,
  // "I want you to", "I'd like you to", "We need to", "I need a".
  /^(?:i|we)\s*(?:'|’)?(?:d|ll)?\s*(?:want|need|would\s+like|like|wanna)\s+(?:you\s+)?(?:to\s+)?/i,
  /^(?:let'?s|lets)\s+/i,
  // "Your job is to", "The task is to", "What I want is to".
  /^(?:your|the|my)\s+(?:job|task|goal|ask|request)\s+is\s+(?:to\s+)?/i,
  // "You should", "You need to", "You must".
  /^you\s+(?:should|need\s+to|must|will)\s+/i,
  /^(?:make\s+sure\s+to|be\s+sure\s+to|go\s+ahead\s+and)\s+/i,
  // A labelled ticket: "Task: build…", "Bug - the header…".
  /^(?:task|ticket|goal|objective|brief|request|feature|bug|issue|todo|to-do)\s*[:–—-]\s+/i,
];

/** How many filler passes to run. Four openers stacked is already unusual. */
const MAX_FILLER_PASSES = 4;

/**
 * Words a truncated label must not END on. Only applied when the word cap
 * actually dropped something: a ticket that genuinely reads "Sign in" must keep
 * its "in", and only a cut can strand a preposition.
 */
const DANGLING = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "for",
  "with",
  "and",
  "or",
  "in",
  "on",
  "at",
  "by",
  "from",
  "into",
  "as",
  "that",
  "but",
  "plus",
  "per",
  "via",
  "about",
  "over",
  "under",
  "like",
  // Clause glue. A cut that lands here strands the label mid-thought
  // ("Redesign the run canvas so it…"); with these gone it reads as a phrase.
  "so",
  "it",
  "if",
  "when",
  "while",
  "which",
  "than",
  "then",
]);

/** Anything that looks like a link, with its punctuation tail left attached. */
const URL_TOKEN = /(?:https?:\/\/|www\.)[^\s<>()[\]"']+/gi;

/** Clause boundaries, in the order they appear; the earliest one wins. */
const CLAUSE_BREAK =
  /(?:[.!?](?=\s|$)|\s[–—-]\s|;\s|:\s|\s\()/;

/**
 * The label. Always a non-empty string.
 *
 * `maxWords` exists so the word cap can be exercised at more than one setting
 * and so a wider surface (a sheet header at 560px) can ask for more words
 * without a second implementation of any of this.
 */
export function ticketLabel(raw: string, maxWords: number = MAX_LABEL_WORDS): string {
  const line = firstMeaningfulLine(raw);
  if (line === "") return UNTITLED_LABEL;

  const unwrapped = unwrapQuotes(line);
  // `lossy` travels the whole way down: text the SERVER already cut must end in
  // an ellipsis even when nothing below drops another word, or the label claims
  // to be a whole sentence when it is the front half of one.
  const { text: whole, lossy } = dropTruncationFragment(unwrapped);
  const { text: deFilled, stripped } = stripFiller(whole);
  const hosted = urlsToHosts(deFilled);

  // The clause cut can leave a stub — "Fix: the thing" has no filler pattern, so
  // the colon rule would answer "Fix". A one-word head is not a summary of a
  // longer sentence, it is a lost sentence, so the whole line is preferred.
  const clause = firstClause(hosted);
  const body = wordsOf(clause).length < 2 && wordsOf(hosted).length >= 2 ? hosted : clause;

  const tokens = wordsOf(body).map(clampToken);
  const capped = capWords(tokens, Math.max(1, maxWords));
  const cut = capped.truncated || lossy;
  const kept = cut ? dropDangling(capped.words) : capped.words;
  if (kept.length === 0) {
    // NOTHING SURVIVED, which in practice means the line was punctuation: a bare
    // "…" or "...". Fall back UP the pipeline rather than to a constant — the
    // owner's words, even bad ones, beat "Untitled" — and use the constant only
    // when what is left has no letter or digit in it at all, because "…" is a
    // worse name for a run than "Untitled ticket" is.
    const fallback = (stripped ? whole : unwrapped).trim();
    return hasWordCharacter(fallback) ? sentenceCase(fallback) : UNTITLED_LABEL;
  }

  const joined = kept.join(" ");
  // ONE ellipsis, never two: `clampToken` may already have put one on the last
  // token, and "Supercalifragilisticexpiali……" is the kind of detail that makes
  // a reader distrust everything else on the chip.
  const label = cut && !joined.endsWith("…") ? `${joined}…` : joined;
  // A label of pure punctuation ("!!!" clause-cut to "!!") names nothing. The
  // constant is a worse name than the owner's words but a better one than that.
  return hasWordCharacter(label) ? sentenceCase(label) : UNTITLED_LABEL;
}

/**
 * The fullest ORIGINAL available for the `title` attribute beside a label.
 *
 * THE POINT OF THIS FUNCTION IS THAT `ticketLabel` DESTROYS INFORMATION. A
 * shortened heading with no way back to the words it shortened is worse than the
 * truncation it replaced, so every call site that renders a label owes the
 * reader this string on hover.
 *
 * `ticketText` is preferred over `ticketTitle`, which the server had already cut
 * to 80 characters. What `ticketText` IS, precisely, because the obvious phrase
 * "the ticket verbatim" would be a lie on some rows: it is the brief the run
 * stored — the owner's prose first, followed by the machine-composed capture
 * block when the ticket named a page to read (`composeBrief`, `ticket-refs.ts`).
 * With no capture the two are byte-identical, which is a property
 * `ticket-refs.test.ts` pins.
 *
 * It is NOT capped here: capping it would recreate the loss this exists to
 * prevent. A very long brief therefore produces a very long tooltip, which is
 * the accepted trade; the fully laid-out copy lives in the run sheet's ticket
 * tab.
 *
 * WHAT IT DOES NOT COVER: `title` is a mouse affordance. It is not announced by
 * every screen reader and it is unreachable by touch. The reachable-for-everyone
 * copy is the sheet, one click away behind "run detail" — that is a fact about
 * `canvas/sheet.tsx`, not a promise made by this function.
 */
export function ticketTooltip(ticketTitle: string, ticketText: string): string {
  const text = ticketText.trim();
  if (text !== "") return text;
  const title = ticketTitle.trim();
  return title === "" ? UNTITLED_LABEL : title;
}

/* ------------------------------------------------------------------ */
/* the steps                                                          */
/* ------------------------------------------------------------------ */

/**
 * First line with words on it, with the markup that prefixes a line removed.
 *
 * Multi-line input is not the common case — `ticketTitle` is already one line —
 * but this function is also the sane thing to call on raw ticket prose, and a
 * caller that passes a whole brief should not get "# Brief" back.
 */
function firstMeaningfulLine(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line
      .replace(/^\s*>+\s*/, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*[-*•+]\s+/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      .trim();
    if (stripped !== "") return stripped;
  }
  return "";
}

/** `"Build the thing"` → `Build the thing`, but only when both ends match. */
function unwrapQuotes(text: string): string {
  const open = /^["'`“‘]/;
  const close = /["'`”’]$/;
  return open.test(text) && close.test(text) && text.length > 2
    ? text.slice(1, -1).trim()
    : text;
}

/**
 * Remove the server's truncation marker AND the half-word in front of it.
 *
 * U+2026 ONLY, AND THAT IS THE WHOLE DISCRIMINATOR. `titleFromBrief` appends
 * `…` to every ticket over 80 characters, so a trailing U+2026 on this
 * input is a machine cut and the token before it is a fragment ("…copy of t").
 * Three ASCII dots are punctuation a person typed, and the word before them is
 * whole, so `Fix the thing...` keeps "thing" and only loses the dots.
 *
 * WHAT IT GETS WRONG: a person who types a real U+2026 (macOS substitutes one in
 * some native fields) loses their last word. Nothing in the string can tell the
 * two apart, and the machine case is the one that actually occurs here — every
 * long ticket in the database has been through `titleFromBrief`.
 */
function dropTruncationFragment(text: string): { text: string; lossy: boolean } {
  const authored = text.replace(/\.{3,}\s*$/, "").trim();
  if (!/…\s*$/.test(authored)) return { text: authored, lossy: false };

  const withoutMarker = authored.replace(/…\s*$/, "");
  // The marker landed after a space: the cut was already on a word boundary, so
  // nothing needs dropping — but text was still lost, hence `lossy`.
  if (/\s$/.test(withoutMarker)) return { text: withoutMarker.trim(), lossy: true };

  const lastSpace = withoutMarker.lastIndexOf(" ");
  // One token and nothing else — the fragment is all there is, so it is kept
  // (bare, without the marker; the caller puts a single ellipsis back on).
  if (lastSpace === -1) return { text: withoutMarker.trim(), lossy: true };
  return { text: withoutMarker.slice(0, lastSpace).trim(), lossy: true };
}

/**
 * Peel request openers off the front.
 *
 * `stripped` is reported back because it gates the article rule: "I need a
 * landing page" should become "Landing page", but "The pricing page is wrong"
 * must keep its "The" — the difference is whether an opener was there.
 */
function stripFiller(text: string): { text: string; stripped: boolean } {
  let current = text;
  let stripped = false;

  for (let pass = 0; pass < MAX_FILLER_PASSES; pass += 1) {
    let changedThisPass = false;
    for (const pattern of FILLER) {
      const next = current.replace(pattern, "").trim();
      // A strip that empties the line is refused: whatever it was, it is the
      // only text this ticket has.
      if (next !== current && next !== "") {
        current = next;
        stripped = true;
        changedThisPass = true;
      }
    }
    if (!changedThisPass) break;
  }

  // A STRIP THAT LEAVES ONLY GLUE IS UNDONE. "I want you to" — a ticket that is
  // pure preamble — peels down to "to", and "To" is a label that says nothing
  // about anything. Reverting gives the reader back the words that were there,
  // which is the same rule as the empty-strip refusal above, one level up.
  if (stripped && !hasContentWord(current)) return { text, stripped: false };

  if (stripped) {
    const withoutArticle = current.replace(/^(?:a|an|the)\s+/i, "").trim();
    if (withoutArticle !== "" && hasContentWord(withoutArticle)) current = withoutArticle;
  }
  return { text: current, stripped };
}

/**
 * True when there is a letter or a digit anywhere — any script, not just Latin.
 * A run named "!!" or "…" is a run with no name.
 */
function hasWordCharacter(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** True when at least one word is not an article, preposition or conjunction. */
function hasContentWord(text: string): boolean {
  return wordsOf(text).some((word) => {
    const bare = word.toLowerCase().replace(/[^a-z']/g, "");
    return bare !== "" && !DANGLING.has(bare);
  });
}

/**
 * Every link becomes its host, in place.
 *
 * IN PLACE, NOT HOISTED. `copy https://www.stripe.com/pricing?utm=x` becomes
 * `copy stripe.com`, which is the same sentence with the noise removed. Moving
 * the host to the front, or substituting it for a phrase like "this site", would
 * be the function asserting what the ticket is about; see the header.
 *
 * `new URL` does the parsing — no network, no DNS, just the WHATWG parser — and
 * anything it refuses is left exactly as the owner wrote it.
 */
function urlsToHosts(text: string): string {
  return text.replace(URL_TOKEN, (token) => hostOf(token) ?? token);
}

function hostOf(token: string): string | null {
  const absolute = /^https?:\/\//i.test(token) ? token : `https://${token}`;
  try {
    const host = new URL(absolute).host;
    return host === "" ? null : host.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

/**
 * The head of the first clause.
 *
 * Sentence enders only count with whitespace or end-of-string after them, which
 * is what keeps `stripe.com` and `v1.2` in one piece.
 */
function firstClause(text: string): string {
  const match = CLAUSE_BREAK.exec(text);
  if (match === null || match.index === 0) return text;
  return text.slice(0, match.index).trim();
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

/** The one mid-word cut in this file, for tokens no line can hold. */
function clampToken(token: string): string {
  return token.length > MAX_TOKEN_CHARS
    ? `${token.slice(0, MAX_TOKEN_CHARS - 1)}…`
    : token;
}

/**
 * Words up to the word cap AND the character budget, whichever runs out first.
 * `truncated` is true only when a word was actually left behind, so the caller
 * never appends an ellipsis to a complete sentence.
 */
function capWords(
  tokens: readonly string[],
  maxWords: number,
): { words: string[]; truncated: boolean } {
  const words: string[] = [];
  let chars = 0;
  for (const token of tokens) {
    if (words.length >= maxWords) break;
    const next = words.length === 0 ? token.length : chars + 1 + token.length;
    if (words.length > 0 && next > MAX_LABEL_CHARS) break;
    words.push(token);
    chars = next;
  }
  return { words, truncated: words.length < tokens.length };
}

/** Never end a cut label on "of" or "the". Never remove the last word. */
function dropDangling(words: readonly string[]): string[] {
  const kept = [...words];
  while (kept.length > 1) {
    const last = kept[kept.length - 1];
    if (last === undefined) break;
    const bare = last.toLowerCase().replace(/[^a-z']/g, "");
    if (!DANGLING.has(bare)) break;
    kept.pop();
  }
  return kept;
}

/**
 * One capital letter, on the first word, and nothing else touched.
 *
 * TITLE CASE EVERY WORD WAS REJECTED. "Make A Copy Of Stripe.com" reads like a
 * press release and mangles the identifiers this tool's tickets are full of
 * (`spec-seat`, `tsc`, `RunDetail`). Sentence case is also what the owner
 * pointed at: Cursor writes "Fix spec-seat abort", not "Fix Spec-Seat Abort".
 *
 * The first token is left alone when it carries a dot, slash, underscore, digit
 * or an interior capital — that is a host, a path or a camelCase identifier, and
 * changing its case would be changing a name.
 */
function sentenceCase(text: string): string {
  const first = text[0];
  if (first === undefined) return text;
  const head = text.split(/\s/, 1)[0] ?? "";
  if (/[./\\_0-9]/.test(head) || /[A-Z]/.test(head)) return text;
  return first.toUpperCase() + text.slice(1);
}
