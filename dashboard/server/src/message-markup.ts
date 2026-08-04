/**
 * message-markup.ts — MODEL ANNOTATION MARKUP, REMOVED ON THE WAY OUT OF THE CHAT.
 *
 * WHAT WAS BROKEN, MEASURED ON THIS MACHINE. `dashboard/data/runs.db`, run
 * `run-2026-08-04T11-08-10-487Z-162b186d`, message seq 19, role `run`. The owner
 * read this in the chat panel, verbatim, angle brackets and all:
 *
 *   Taking it: real section, not decoration. /about gets a "HOW I BUILD" flow using
 *   the CV's seven build bullets — <cite index="1-6,1-8,1-11,1-13,1-15,1-18,1-22">
 *   Environment first, Named specialists, Skills read at run time, …</cite> — each
 *   with a circled digit 1–7 …
 *
 * The planning seat is given the CV as a document and answered with a CITATION
 * ANNOTATION around the span it took from it. Nothing on the path from
 * `plan-dialogue`'s `say` → `orchestrator.ts:1256` → `RunStore.appendMessage`
 * (`db.ts:1025`) → `GET /api/runs/:id/messages` (`http.ts:1079`) knew that markup
 * was markup, so it was stored as prose and rendered as prose.
 *
 * ============================================================
 * THE MARKUP GOES, THE PROSE STAYS. THAT IS THE WHOLE RULE.
 * ============================================================
 *
 * "Environment first, Named specialists, Skills read at run time, Hooks on every
 * write, Adversarial review, /debugfix, db-scale-audit" IS THE MESSAGE. It is the
 * seven build steps the owner asked about, inside the tag because that is where a
 * citing model puts the thing it cited. A fix that deleted the wrapped span would
 * remove the answer and leave the question, which is worse than the bug it fixes.
 * So nothing here ever drops content: it drops TAGS and keeps everything between
 * them. `message-markup.test.ts` asserts every word of that span survives.
 *
 * ============================================================
 * WHY THIS RUNS ON READ AND NOT ON WRITE, ARGUED RATHER THAN ASSUMED.
 * ============================================================
 *
 * `RunStore.appendMessage` is the single write chokepoint and sanitising there
 * would be cheaper — once per row instead of once per read. It was rejected for
 * two reasons, in this order:
 *
 *   1. THE TRANSCRIPT IS EVIDENCE. The `messages` table is the record of what the
 *      run actually said. Every other thing this program stores about a run is
 *      kept verbatim precisely so a later question about it can be answered from
 *      disk; a chat row rewritten before it lands is a record of what the server
 *      wished the model had said. The one existing exception is credential
 *      redaction, which is destructive on purpose because the alternative is a
 *      key on disk. Stray markup is a display defect, and a display defect does
 *      not earn a destructive write.
 *   2. IT REPAIRS HISTORY. Sanitising on write cannot touch the row already on
 *      disk — the owner would still see the leak in the run he complained about,
 *      and only new runs would be clean. Sanitising on read fixes that row on the
 *      next fetch, with no migration. There is deliberately NO migration in this
 *      change: rewriting the stored text would give up reason 1 to save a regex
 *      pass over a few hundred characters.
 *
 * The cost is honest: this runs on every read of every message. It is a bounded
 * regex over strings capped at 400 characters (`plan-turn.ts:59`) or 2000
 * (`owner-message.ts:REPLY_MAX_CHARS`), on a table that holds tens of rows per
 * run, called from one HTTP handler.
 *
 * ============================================================
 * WHAT IS STRIPPED, WHAT IS DELIBERATELY LEFT, AND WHY THE LINE IS HERE.
 * ============================================================
 *
 * STRIPPED: tags whose NAME is in {@link ANNOTATION_TAGS}, plus anything in the
 * `antml:` namespace. Closed set, listed by hand, greppable.
 *
 * LEFT ALONE: every other angle-bracket span, without exception. `<div>`,
 * `<section>`, `<MyComponent />`, `<T extends string>`, `a < b && c > d`. A run
 * message about a React ticket legitimately contains element names, and the owner
 * types them into the chat himself. This module is NOT an HTML parser and must
 * never become one — it does not know what a tag is, only what these tags are.
 *
 * WHY AN ALLOWLIST RATHER THAN "STRIP TAGS THAT ARE NOT REAL HTML". Because the
 * two failure modes are not symmetrical. An annotation tag this list has not heard
 * of leaks VISIBLY: it shows up in the chat, looks wrong, gets reported, and gets
 * added here — exactly how `cite` arrived. An over-broad rule eats prose SILENTLY:
 * the owner never learns that the sentence he is reading is missing a clause. The
 * list is closed because the cheap failure is the one on the outside of it.
 *
 * THE ACCEPTED FALSE POSITIVE, NAMED. A message that discusses the HTML `<cite>`
 * element by writing it out loses those brackets. That is a real cost and it is
 * taken knowingly: it applies only to `run` rows (see below), and the alternative
 * — leaving the leak in place — is what the owner actually complained about.
 *
 * ============================================================
 * ROLE-GATED AT THE CALL SITE, AND THE REASON IS THE PROMPT PATH.
 * ============================================================
 *
 * `db.ts` applies this to `role === "run"` rows only. Not out of tidiness:
 * `RunStore.pendingMessages` (`db.ts:1075`) reads through the same `messages()`
 * and its rows are folded into the next segment's prompt by `ownerMessageBlock`.
 * An owner who writes "wrap the quote in a <cite> tag" must have that instruction
 * reach the model BYTE FOR BYTE. Owner text is never touched here, so the prompt
 * path cannot be altered by a display fix.
 *
 * ============================================================
 * COMPOSITION WITH `redactForPersistence`, CHECKED RATHER THAN ASSUMED.
 * ============================================================
 *
 * Credential redaction already ran on the way in (`db.ts:appendMessage`) and its
 * replacements are `[REDACTED:NAME:len]` — SQUARE brackets, no angle brackets and
 * no tag name from the list below. Nothing here can match one, so a redacted span
 * survives this pass intact and the redaction is not weakened. The test file
 * asserts that directly rather than leaving it to inspection.
 */

/**
 * The annotation tag names this module removes.
 *
 * ALL LOWER CASE; matching is case-insensitive because a model that emits
 * `<Cite>` has emitted the same annotation.
 *
 * `cite`/`citation` are the measured one. The rest are the same class of thing —
 * wrappers a model puts around its own reasoning, its sources, or a tool call
 * when it is talking to a harness that strips them and this one does not. They
 * are listed because seeing one in the chat is the same defect with a different
 * word in it, not because any of them has been observed here.
 *
 * NOT ON THIS LIST AND DELIBERATELY SO: every HTML element name. `<p>`, `<div>`,
 * `<section>`, `<code>` are things a ticket talks about, not things a model wraps
 * its answer in.
 *
 * `source` WAS ON THIS LIST AND WAS REMOVED, which is the rule above doing its
 * job rather than an oversight. It is a plausible annotation wrapper AND a real
 * HTML element — the child of `<picture>`, `<video>` and `<audio>` — and this
 * product's runs write exactly that markup, since `design-prompt.ts` asks for a
 * scrubbable `.mp4` with a `.webp` poster. A run reporting "added a `<source>`
 * for the webp" would have lost the brackets SILENTLY, which is the failure the
 * closed list exists to avoid, in exchange for a tag never once observed here.
 * `<source>` is in the survival test's fixture so the boundary is defended and
 * not merely asserted in this comment.
 */
export const ANNOTATION_TAGS: readonly string[] = [
  "antthinking",
  "citation",
  "citations",
  "cite",
  "document",
  "document_content",
  "documents",
  "function_calls",
  "function_results",
  "invoke",
  "parameter",
  "search_quality_reflection",
  "search_quality_score",
  "thinking",
];

/** `antml:anything` — the namespace, so a new tag inside it needs no edit here. */
const NAMESPACED = "antml:[A-Za-z0-9_.-]+";

const NAMES = `(?:${[...ANNOTATION_TAGS, NAMESPACED].join("|")})`;

/**
 * One annotation tag, in every form the storage path can produce.
 *
 * FOUR FORMS, AND THE FOURTH IS THE ONE A NAIVE PATTERN MISSES.
 *
 *   1. `<cite index="…">` — an opening tag with attributes.
 *   2. `<cite>` — an opening tag without.
 *   3. `</cite>` — a closing tag.
 *   4. `<cite index="1-6,1-…` — AN OPENING TAG WITH NO `>` AT ALL, because
 *      `plan-turn.ts:356` truncates the seat's reply at 400 characters BEFORE it
 *      is stored. The cut lands wherever it lands. The leaked row happens to have
 *      kept its `</cite>`; that is luck, not design, and a pattern that only
 *      matched balanced pairs would render the raw attribute string to the owner
 *      on the next unlucky cut. `$` with the `m` flag would be wrong here — a cut
 *      only ever happens at the END OF THE WHOLE STRING, and anchoring per line
 *      would let a stray `<source` mid-message swallow the rest of its line.
 *
 * `[^<>]*` bounds the attribute run so an unclosed `<` cannot consume the rest of
 * the message. The known limit: an attribute VALUE containing a literal `>` ends
 * the match early and leaves the remainder as text. No model annotation observed
 * or plausible does that, and the alternative is quoting rules, i.e. a parser.
 *
 * SURROUNDING HORIZONTAL WHITESPACE IS PART OF THE MATCH so the join can be
 * repaired — see {@link stripAnnotationMarkup}. `[ \t]` only: a newline either
 * side of a stripped block tag is layout the message chose and is left alone.
 */
const TAG = new RegExp(`([ \\t]*)(?:</?${NAMES}(?:\\s[^<>]*)?>|<${NAMES}(?:\\s[^<>]*)?$)([ \\t]*)`, "giu");

/**
 * Remove annotation markup from one message's text, keeping every word of prose.
 *
 * THE WHITESPACE RULE, WHICH IS WHY THE MATCH IS WIDER THAN THE TAG. A tag is
 * removed together with the spaces on either side of it, and ONE space is put
 * back if there was whitespace on either side. Both halves matter:
 *
 *   - `bullets — <cite …>Environment` must become `bullets — Environment` and not
 *     `bullets —  Environment` with the doubled space the naive removal leaves.
 *   - `db-scale-audit</cite> — each` must become `db-scale-audit — each` and not
 *     `db-scale-audit— each`, which is why the space is put BACK rather than just
 *     swallowed.
 *
 * A tag with no whitespace on either side (`<thinking>text</thinking>`) closes up
 * with nothing inserted, so a tag glued to a word cannot split it.
 *
 * THE RULE IS APPLIED WITHOUT AN EXCEPTION, INCLUDING AT THE END OF THE STRING: a
 * truncated tag that ran to end-of-string had a space before it, so a space is put
 * back and the result ends in one. That trailing space renders as nothing, and a
 * branch here to suppress it would be a second rule earning a character.
 *
 * IDEMPOTENT: the output contains no annotation tags, so a second pass is a no-op.
 * That matters because nothing guarantees this is called exactly once on a value.
 */
export function stripAnnotationMarkup(text: string): string {
  return text.replace(TAG, (_match, before: string, after: string) =>
    before.length + after.length > 0 ? " " : "",
  );
}
