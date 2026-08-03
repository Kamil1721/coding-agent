/**
 * design-dialogue.ts — the design park's LIVE half: turns, caps, and the drain.
 *
 * THE LOCK IS A CONVERSATION, NOT A RADIO BUTTON. While the run is parked on a
 * canvass the owner can ask for a named section rendered in a named direction —
 * "show me the contact page in 3" — and get it back in the same panel, BEFORE he
 * commits to anything. Only then does he pick.
 *
 * ─── WHAT THIS FILE IS A COPY OF, AND WHAT IT REUSES ───
 *
 * `plan-dialogue.ts` solved every hard part of a bounded exchange over a park:
 * a timer that is the LIVE half of a bound whose durable half is on disk, the
 * `askedAfterSeq` cut, the in-flight guard, the drain loop, and an expiry that
 * PROCEEDS rather than hangs. This mirrors that shape rather than inventing a
 * second one, and it REUSES rather than rebuilds:
 *
 *   · the park itself — `#parkForDesignLock`, its `parkedAt`, its timer and
 *     `reconcileOnBoot`'s re-arm. There is no second park and no second clock.
 *   · `POST /api/runs/:id/messages`, `pendingMessages` and `markMessagesDelivered`.
 *     One intake, one delivery stamp.
 *   · the `log` channel and the `screenshot` event.
 *
 * The three drivers are disjoint BY CONSTRUCTION: `pushLiveMessage` refuses a
 * parked run, `PlanDriver.#parked` refuses a FOLDED `plan.json` (which is
 * precisely what a run parked for a design has), and {@link DesignDialogueDriver.#parked}
 * requires `awaiting_input` + `design-lock.json.awaiting` + a canvass with no
 * choice yet.
 *
 * ─── ONE DIVERGENCE FROM `PlanDriver`, STATED ───
 *
 * NO `say()`. The plan driver writes `run` chat rows because it carries MODEL
 * text — a seat's own sentences. This dialogue's answer is HOST-COMPOSED: the
 * image prompt is built mechanically from `direction-<slug>.md` plus the section
 * name, with the direction's hero passed as `-i` to hold the palette. No seat
 * call, no model turn. db.ts's `ChatRole` forbids the server writing a `run` row
 * of its own composition, so the answer reaches the owner as the PUBLISHED STILL
 * (an `addScreenshot` row and a `screenshot` event, in the same panel he is
 * already looking at), plus a `log` line and the `requests[]` entry on the wire.
 *
 * ─── THE CAPS ARE CODE, NOT PROMPT TEXT ───
 *
 * `MAX_DESIGN_LOCK_TURNS` bounds the exchange and `MAX_DESIGN_ON_DEMAND_RENDERS`
 * bounds the spend, both on disk in `design-lock.json` so a restart cannot reset
 * them. Turns exceed renders on purpose: a refusal (a direction that does not
 * exist, a message that names no section) costs a turn and no image, and EVERY
 * message the dialogue claims costs a turn whatever it contained — `plan-state.ts`
 * rule 6's precedent. When either cap is reached the panel says so in words
 * rather than the run silently ignoring him.
 *
 * THE RENDER CAP COUNTS GENERATIONS ATTEMPTED, WHICH IS WHAT "SPEND" MEANS. A
 * generation that ran and failed is charged — the money is gone either way — and
 * one the host never invoked is not (`DesignRenderResult.attempted`). Charging
 * the second was measured on the DEGRADED park, where the answer is always
 * "there is no image generation on this machine": six honest refusals and the
 * owner was told his budget was spent, with no image in existence.
 *
 * A MESSAGE THE PARSER DECLINES COSTS NEITHER. It is never claimed, so it spends
 * no turn and stays pending for the build.
 *
 * THAT IS A PROPERTY OF WHAT A DECLINE DOES, NOT A CLAIM THAT THE PARSER IS
 * RIGHT. {@link matchDirectionReference} decides which way to fail across its
 * five arms, and it takes the decline on every one of them: a number without a
 * label this park uses, a label this park does not use, and — on all five at once
 * — a direction referred to in a sentence that ALSO TELLS THE BUILD WHAT TO
 * CHANGE. Each of those cost a turn and a render before it was measured. What is
 * NOT claimed here is that it declines everything it should — a message that
 * dresses an instruction up as a request ("show me a taller hero in editorial
 * slab") is still read as a request, and the only defence against that one is
 * that it costs an image rather than a sentence.
 * {@link DesignDialogueDriver.deliver} says a near-miss out loud, on every arm,
 * so a decline is never silence.
 */

import type { ChatMessage, RunRow } from "./db.js";
import { isTerminal } from "./db.js";
import type { DesignLockRecord, DesignRenderOutcome, DesignRenderRequest } from "./design-lock.js";
import { designLockExpired, designLockTimeoutMin, readDesignLock, writeDesignLock } from "./design-lock.js";
import type { DesignDirection, DesignManifest } from "./design-manifest.js";
import { MAX_DESIGN_LOCK_TURNS, MAX_DESIGN_ON_DEMAND_RENDERS } from "./design-prompt.js";

export type DesignLogLevel = "info" | "warn" | "error";

/**
 * THE SENTENCE THE PANEL AND THE RUN LOG BOTH CARRY, declared once.
 *
 * The suite was FROZEN in the `spec` phase, which is over before the design lane
 * runs at all. Nothing asked at this park can add or change an acceptance
 * criterion — it changes what gets BUILT and what the build is compared against
 * VISUALLY, and nothing else. An owner who asks for a whole new page here is
 * asking for something the verdict will not check, and letting him believe
 * otherwise is the failure this string exists to prevent.
 */
export const DESIGN_FROZEN_SUITE_NOTICE =
  "The acceptance suite was frozen in the spec phase. What you ask for here changes what gets built " +
  "and what the build is compared against visually — it does not change what counts as done.";

/** What an owner asked for, once it has been resolved against the manifest. */
export interface DesignRequest {
  readonly section: string;
  /** The slug of a DECLARED direction, or the label he used for one that is not. */
  readonly direction: string;
  /** The direction resolved, or null when he named one that does not exist. */
  readonly resolved: DesignDirection | null;
  /** True when the section is not one the canvass or the brief already covers. */
  readonly offBrief: boolean;
}

/** What the host did with it. */
export interface DesignRenderResult {
  readonly outcome: DesignRenderOutcome;
  readonly detail: string;
  /** The WORKSPACE ref it produced, or null. */
  readonly path: string | null;
  /**
   * WAS A GENERATION ACTUALLY RUN — the field that decides whether this costs a
   * render, and the reason it is not derived from `outcome`.
   *
   * `outcome: "failed"` covers two different events. One is a generation that was
   * INVOKED and came back non-zero, threw, or wrote no file: the call was made,
   * the money is gone, and the cap must count it or it becomes a bound on luck.
   * The other is a request that never reached the tool at all — no image
   * generation on this machine, an unreadable manifest — where charging a render
   * for a call nobody made would spend a degraded park's whole budget on the one
   * lane that can never draw anything. `true` from the moment the image tool is
   * invoked, and only then.
   */
  readonly attempted: boolean;
}

export interface DesignDialogueHost {
  readonly env: NodeJS.ProcessEnv;
  /** `runs/<id>/results`, where `design-lock.json` lives. */
  resultsDir(runId: string): string;
  getRun(runId: string): RunRow | null;
  /** The run's parsed manifest, or null. */
  manifest(runId: string): DesignManifest | null;
  /** Owner messages this run has not taken up, oldest first. */
  pendingMessages(runId: string): readonly ChatMessage[];
  /** Stamp them consumed. Called only AFTER `design-lock.json` is written. */
  markDelivered(runId: string, seqs: readonly number[]): void;
  log(runId: string, level: DesignLogLevel, text: string): void;
  /**
   * Generate ONE still for this request and publish it. Never throws — a failed
   * generation is a `DesignRenderResult` with `outcome: "failed"`, because a
   * throw here would take down a park the owner is sitting in.
   *
   * THE HOST ALSO SAYS WHETHER IT ACTUALLY RAN ANYTHING
   * ({@link DesignRenderResult.attempted}); this driver charges the render cap on
   * that answer and never infers it from `outcome`.
   */
  render(runId: string, request: DesignRequest): Promise<DesignRenderResult>;
}

/**
 * The 1-based ordinal words, so "the third" is addressable and not merely
 * claimed to be. Ten is well past `DESIGN_DIRECTION_COUNT`; an ordinal past the
 * end resolves to nothing and is refused by name, exactly as "design 7" is.
 */
const ORDINAL_WORDS: readonly string[] = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

/**
 * THE FOUR SHAPES A DIRECTION REFERENCE CAN TAKE, and every one of them LABELS
 * the number. A bare `\b\d{1,2}\b` is not among them, and that omission is the
 * whole point — see {@link matchDirectionReference}.
 *
 * THE LABEL MUST BE A WORD THIS PARK ITSELF USES FOR A DIRECTION, and the four
 * here are exactly the panel's and the park's own vocabulary. `versions?`,
 * `number` and `nos?\.` were in this list until 2026-08-03 and are the reason it
 * needed narrowing: they are ordinary BUILD words, so "put the phone number 2
 * lines below the address in the footer" resolved to direction 2, drew its
 * footer, and stamped the message delivered — the instruction never reached the
 * build segment. A label a sentence can carry innocently is not a label; it is a
 * guess, and the tie-break in {@link matchDirectionReference} rules guesses out.
 */
const LABELLED_ORDINAL = /\b(?:designs?|directions?|options?|variants?)\s*#?(\d{1,2})\b/u;
/** `#2` — the panel numbers the groups, and this is how that number gets typed. */
const HASH_ORDINAL = /(?:^|[\s(])#(\d{1,2})\b/u;
/**
 * `in 3`, `in 2,`, `in 1 please` — the phrasing the park's own log line invites
 * ("show me the contact section in 2"), READ ONLY AT A CLAUSE END.
 *
 * THE LOOKAHEAD IS THE QUANTITY TEST. "show me the hero in 3 columns" and "in 2
 * weights" are measurements, not directions; a number followed by a noun is
 * counting something. Requiring the clause to END there (or to close with one of
 * a handful of trailing words) costs the occasional render the owner has to ask
 * for twice, and that is the cheap side of the trade: a swallowed instruction is
 * unrecoverable, a missed render is one more sentence from him.
 */
const IN_ORDINAL = /\bin\s+#?(\d{1,2})(?=\s*(?:[.,;:!?)\]]|$)|\s+(?:please|thanks|instead|too|also|now|then)\b)/u;
/** `the third`, `the third one`, `the first direction` — same clause-end rule. */
const WORD_ORDINAL = new RegExp(
  `\\bthe\\s+(${ORDINAL_WORDS.join("|")})\\b(?=\\s*(?:[.,;:!?)\\]]|$)|\\s+(?:one|design|direction|option|variant|version)\\b)`,
  "u",
);

/**
 * DOES THIS MESSAGE ALSO TELL THE BUILD WHAT TO CHANGE — the ONE question that
 * separates a request from an instruction, asked the same way on all five arms.
 *
 * WHAT THIS REPLACED, AND WHY THE OLD QUESTION COULD ONLY EVER GATE ONE ARM. The
 * first cut of this rule asked "does the message ASK for a picture" and was
 * applied to the SLUG/NAME arm alone, because it is the only arm it CAN be
 * applied to: "the footer in 2, please" asks for nothing and is a plain request,
 * so an ask-gate over the number arms would refuse the sentence the park's own
 * log line invites. The four number arms were therefore left ungated, and two
 * sentences one shape apart went opposite ways (measured 2026-08-03):
 *
 *   "I like editorial slab, but make the hero taller" → declined, correctly.
 *   "I like design 2, but make the hero taller"       → drew direction 2's hero,
 *     spent a turn and a render on a picture of the thing he asked to CHANGE, and
 *     stamped the message delivered so the build segment never saw the sentence.
 *
 * "Discussing a direction and asking for a picture of one are the same words
 * minus the ask" is true of "design 2" and "the second one" as well as of a name.
 * The difference this asks about instead — DOES IT ALSO INSTRUCT — has an answer
 * on every arm, and needs no per-arm exception.
 *
 * BROAD ON PURPOSE, WHICH IS THE EXACT INVERSE OF `LABELLED_ORDINAL`'s NARROWING
 * AND THE SAME TIE-BREAK. That list had to be narrow because a false positive
 * there CLAIMS a message: it spends a render, and the sentence is stamped and
 * lost. This one is the other polarity — a false positive DECLINES a message,
 * which costs no turn, stamps nothing, leaves the sentence pending for the build
 * and is said out loud by {@link DesignDialogueDriver.deliver}, so the owner
 * retypes it. A false negative here is the unrecoverable one. So a bare verb,
 * which would be a guess in a proof, is the right shape in a veto.
 *
 * `draw` IS THE ONE CARRY-OVER AND IT MOVES SIDES, NOT MEANINGS. The ask list it
 * came from already recorded that a bare `draw` reads innocently ("draw the eye
 * to the CTA") and that "draw the hero in editorial slab" was declined for it.
 * `draw` NOT followed by `me`/`us` is that same judgement written as a veto, so
 * both sentences keep the answer they had.
 *
 * WHAT THIS DOES NOT DECIDE, STATED SO THE NEXT READER DOES NOT ASSUME IT:
 *
 *   · A MESSAGE THAT BOTH ASKS AND INSTRUCTS IS AN INSTRUCTION. "show me the
 *     hero in 2, and make the footer smaller" is declined, deliberately: the ask
 *     can be retyped and the instruction cannot be recovered. (Measured. Drop the
 *     comma and it is declined by `IN_ORDINAL`'s clause-end rule instead, before
 *     this gate is consulted — and then SILENTLY, since there is no reference to
 *     name back.)
 *   · AN INSTRUCTION IN A SHAPE NOT LISTED HERE STILL RESOLVES. This is a list of
 *     shapes, not an understanding of English — "show me a taller hero in
 *     editorial slab" carries none of them and is still read as a request, and
 *     the only defence against that one remains that it costs an image rather
 *     than a sentence.
 *   · IT SAYS NOTHING ABOUT WHICH DIRECTION HE MEANT. That is
 *     {@link matchDirectionReference}'s five arms, and this gate sits in front of
 *     all of them rather than inside any one.
 */
const BUILD_INSTRUCTION = new RegExp(
  [
    // Imperative change verbs — the plain "do this to the build" shape.
    String.raw`\b(?:make|add|remove|delete|drop|cut|change|swap|replace|move|put|set|use|keep|avoid|skip|hide|reorder|rename|resize|align|centre|center|update|fix|adjust|simplify|tidy|trim)\b`,
    // The same, in the vocabulary design notes are actually written in.
    String.raw`\b(?:tighten|loosen|lighten|darken|brighten|soften|shrink|enlarge|widen|narrow|shorten|lengthen|raise|lower|increase|decrease|reduce|bump|boost)\b`,
    String.raw`\b(?:tone|dial|scale)\s+(?:it\s+|them\s+|the\s+\w+\s+)?(?:down|back|up)\b`,
    String.raw`\b(?:go|stick)\s+with\b`,
    String.raw`\bswitch\s+to\b`,
    // A prohibition is an instruction: "don't show the nav on mobile".
    String.raw`\b(?:don[’']?t|do\s+not|never)\b`,
    // A requirement or a preference is an instruction with a softer verb.
    // `instead OF` and `rather THAN` only — bare `instead` is one of the trailing
    // words `IN_ORDINAL` allows ("show me the hero in 2 instead").
    String.raw`\b(?:should|must|needs?\s+to|has\s+to|have\s+to|instead\s+of|rather\s+than|prefers?)\b`,
    // A CRITIQUE IS AN INSTRUCTION WITH THE VERB LEFT OFF. "editorial slab's type
    // is too big for the hero" names no action and is plainly a change request.
    // `too` alone would catch the trailing "…, too" `IN_ORDINAL` allows, so it
    // must carry the adjective — and not the polite trailers.
    String.raw`\btoo\s+(?!please\b|thanks\b)[a-z]{2,}\b`,
    String.raw`\bfeels?\b`,
    // "draw the eye to the CTA" — see the docblock; `draw me`/`draw us` is a
    // request and everything else was already a decline.
    String.raw`\bdraw\b(?!\s+(?:me|us)\b)`,
  ].join("|"),
  "u",
);

/** Whether this message tells the build what to change. Lowercased input. */
function carriesBuildInstruction(lower: string): boolean {
  return BUILD_INSTRUCTION.test(lower);
}

/** Whether this message names this direction at all, by slug or by name. */
function namesDirection(lower: string, direction: DesignDirection): string | null {
  if (lower.includes(direction.slug.toLowerCase())) return direction.slug;
  if (direction.name.trim().length > 0 && lower.includes(direction.name.toLowerCase())) return direction.name;
  return null;
}

/** A direction the owner referred to — resolved, or named and non-existent. */
export interface DirectionReference {
  /** What he called it, for a refusal that can name it back to him. */
  readonly label: string;
  /** The direction it names, or null when this run declares no such direction. */
  readonly direction: DesignDirection | null;
}

/**
 * THE FIVE ARMS, and NOTHING ELSE — no gate, no judgement about what the message
 * is FOR. Which direction the words point at, if any.
 *
 * SHARED BY THE PARSE AND BY THE DECLINE NOTICE ON PURPOSE. Those two must agree
 * about which arms exist or the notice goes silent on the arms it does not know:
 * {@link matchDirectionReference} is this plus the gate, and
 * {@link declinedDirectionReference} is this plus the gate's negation, so an arm
 * added here reaches both.
 *
 * SLUG AND NAME ARE TRIED FIRST, so a direction literally named "3" wins over the
 * digit 3 in the same sentence.
 */
function referencedDirection(lower: string, directions: readonly DesignDirection[]): DirectionReference | null {
  for (const direction of directions) {
    const label = namesDirection(lower, direction);
    if (label !== null) return { label, direction };
  }
  const digits = LABELLED_ORDINAL.exec(lower) ?? HASH_ORDINAL.exec(lower) ?? IN_ORDINAL.exec(lower);
  if (digits !== null) {
    const label = digits[1] ?? "";
    // 1-BASED, AND IT MUST NOT WRAP OR CLAMP. `directions[-1]` and `directions[9]`
    // are both `undefined`, which is the refusal — rendering the nearest match
    // would hand him a picture of direction 1 for the direction 4 he asked about.
    return { label, direction: directions[Number.parseInt(label, 10) - 1] ?? null };
  }
  const word = WORD_ORDINAL.exec(lower);
  if (word !== null) {
    const label = word[1] ?? "";
    return { label, direction: directions[ORDINAL_WORDS.indexOf(label)] ?? null };
  }
  return null;
}

/**
 * WHICH DIRECTION HE MEANT — the ONE authority on that question.
 *
 * ADDRESSABLE FIVE WAYS, because the panel shows all three groups and numbers
 * them: by SLUG, by NAME, by LABELLED DIGIT ("design 3"), by HASH ("#3"), by `in
 * 3` at a clause end, and by WORD ORDINAL ("the third", "the second one").
 *
 * ─── ONE GATE IN FRONT OF ALL FIVE, AND EACH ARM STILL PROVES ITS REFERENCE ───
 *
 * The gate is {@link BUILD_INSTRUCTION}: a message that also tells the build what
 * to change is an INSTRUCTION whichever arm names the direction, and is declined.
 * It sits here, once, in front of `referencedDirection`, because the four
 * measurements below were four halves of the same rule applied one arm at a time
 * — the shape this file has been fixed for three rounds running:
 *
 *   THE BARE DIGIT. The ordinal expression reduced to any `\b\d{1,2}\b`, so "make
 *     the hero 2 lines instead of 3" resolved to direction 2, spent a turn and a
 *     render drawing its hero, AND was stamped delivered — so the instruction
 *     never reached the build segment either. Every number read now is LABELLED
 *     (`design 3`, `#3`) or sits at the end of an `in …` clause.
 *   THE LABEL. `versions?`, `number` and `nos?\.` were labels, and all three are
 *     words a build instruction carries innocently: "put the phone number 2 lines
 *     below the address in the footer" named a direction AND a section, so it
 *     parsed to a resolved request and drew direction 2's footer. THE LABEL MUST
 *     BE A WORD THIS PARK USES FOR A DIRECTION.
 *   THE NAME. This arm matched on `String.includes` alone until 2026-08-03, so it
 *     lost the identical sentences one shape over: "I like editorial slab, but
 *     make the hero taller" drew a picture of the thing he asked to CHANGE.
 *   ALL FIVE, THE SAME DAY. The fix for the name arm was an ASK-gate on that arm
 *     only, so "I like DESIGN 2, but make the hero taller" was still drawn — and
 *     so were "design 2 is too dark, lighten the hero", "#3 is too dark, lighten
 *     the hero", "lighten the hero in 2" and "the second one is too busy, tone
 *     down the hero". An ask-gate could not be widened to the number arms
 *     ("the footer in 2, please" asks for nothing and is a plain request), which
 *     is why the question is now the one that has an answer on every arm.
 *
 * A NAME NO LONGER NEEDS AN ASK, and that is a consequence rather than a
 * concession: "the QUIET-GRID one" is word-for-word "the second one", which has
 * always resolved. It carries no section, so the answer is the `no-section`
 * refusal — a turn, no render, and the message stamped.
 *
 * A MESSAGE THAT PROVES NOTHING IS DECLINED, which costs the owner nothing: a
 * declined message is never claimed, so it spends no turn, and it stays pending
 * for the build. He asks again in the park's own words — one more sentence — and
 * {@link DesignDialogueDriver.deliver} says so on the run log, so a decline is
 * not silence.
 *
 * NULL IS "NOT A REQUEST", WHICH IS NOW TWO CASES: he named no direction at all,
 * or he named one and told the build what to change in the same breath. Neither
 * is the same as a reference whose `direction` is null — "he named one that does
 * not exist" — which is REFUSED BY NAME and costs a turn. Conflating the first
 * two with the third would swallow instructions.
 */
export function matchDirectionReference(
  text: string,
  directions: readonly DesignDirection[],
): DirectionReference | null {
  const lower = text.toLowerCase();
  if (carriesBuildInstruction(lower)) return null;
  return referencedDirection(lower, directions);
}

/**
 * The direction this message resolves to AS A RENDER REQUEST, or null.
 *
 * NULL FOR A MESSAGE THAT MENTIONS ONE WHILE INSTRUCTING THE BUILD. It is
 * {@link matchDirectionReference} with the reference thrown away, so the gate and
 * every arm's proof apply here unchanged. {@link declinedDirectionReference} is
 * the question "did the gate turn one away".
 */
export function matchDirection(text: string, directions: readonly DesignDirection[]): DesignDirection | null {
  return matchDirectionReference(text, directions)?.direction ?? null;
}

/**
 * THE NEAR MISS: a direction this message refers to, in a sentence the gate read
 * as an instruction. Exactly {@link matchDirectionReference}'s negation.
 *
 * WHY A DECLINE NEEDS A VOICE. The tie-break above is only cheap if the owner
 * finds out — "design 2 is too dark, lighten the hero" is now read as an
 * instruction, which is right, but a man who meant "show me direction 2's hero"
 * would otherwise get silence and a run that carried on. This is what turns a
 * decline into a sentence he can act on: it names the direction back to him and
 * the phrasing that would have worked.
 *
 * ALL FIVE ARMS, BECAUSE IT SHARES `referencedDirection` WITH THE PARSE. This
 * function tested only the NAME arm while the parse gated only the NAME arm; the
 * two agreed by coincidence, and gating the other four without touching this
 * would have turned four loud losses into four SILENT declines — the property
 * the ask-gate had just bought, lost one round later. Sharing the arms is what
 * makes that mistake unavailable rather than merely unmade.
 *
 * THE REFERENCE AND NOT THE DIRECTION, so a label this run cannot resolve still
 * has a voice: "design 7, but make the hero taller" declines with
 * `direction: null`, and the caller says "7" back to him.
 *
 * IT IS NOT PART OF THE PARSE AND MUST NOT BECOME ONE. It costs no turn, claims
 * no message and renders nothing — {@link matchDirectionReference} remains the
 * single authority on what a request IS.
 *
 * NULL WHEN THE MESSAGE INSTRUCTS NOTHING, because such a message is the parse's
 * business and not this one's. Two things happen to one, and only the second is
 * silent: it resolves (and this is never called), or it names nothing
 * addressable at all — "show me the hero in editrial slab" — and is declined with
 * no notice, exactly as a message that names nothing is. That one is stated
 * rather than fixed: a typo the parser cannot tell from a section-only question
 * ("show me the hero") is a sentence to repeat, not a loss.
 *
 * A TRAILING TYPO IS NOT THAT CASE, AND THE EXAMPLE ABOVE WAS WRONG UNTIL IT WAS
 * MEASURED (2026-08-03). {@link namesDirection} matches by `String.includes`, so
 * "editorial slabb" CONTAINS "editorial slab" and resolves — it is drawn, not
 * declined. That is a separate looseness in the NAME arm, on the claiming side,
 * and it is recorded here rather than claimed away.
 */
export function declinedDirectionReference(
  text: string,
  directions: readonly DesignDirection[],
): DirectionReference | null {
  const lower = text.toLowerCase();
  if (!carriesBuildInstruction(lower)) return null;
  return referencedDirection(lower, directions);
}

/**
 * The SECTION he asked for.
 *
 * MATCHED AGAINST THE MANIFEST'S OWN SECTION NAMES FIRST, then against a short
 * list of the words a page is normally divided into. A section outside both is
 * still rendered — refusing to draw "the pricing page" because the canvass did
 * not include one would be the dashboard deciding what he may look at — but it is
 * REPORTED as off-brief, so the panel can say it is not one of the sections the
 * build will produce.
 */
const COMMON_SECTIONS: readonly string[] = [
  "hero",
  "nav",
  "header",
  "footer",
  "about",
  "work",
  "projects",
  "portfolio",
  "contact",
  "pricing",
  "features",
  "testimonials",
  "faq",
  "team",
  "blog",
  "gallery",
  "services",
  "cta",
  "checkout",
  "dashboard",
  "settings",
  "login",
  "signup",
  "onboarding",
];

/**
 * A WHOLE WORD, NOT A SUBSTRING, and the case that forced it was measured: with
 * `String.includes`, "what about a pricing page" matched `about` — the word
 * inside "what about" — and rendered the ABOUT section for a man who asked for
 * pricing. A word boundary alone does not fix it (`about` really is a word
 * there), so the LONGEST match wins, which is what separates a section named in
 * passing from the one he is asking about.
 */
function wordIndex(haystack: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "u").exec(haystack)?.index ?? -1;
}

export function matchSection(text: string, manifest: DesignManifest): { section: string; offBrief: boolean } | null {
  const lower = text.toLowerCase();
  const known = [...new Set(manifest.refs.map((ref) => ref.section.toLowerCase()))].filter(
    (section) => section.length > 0,
  );
  // THE RUN'S OWN SECTION NAMES WIN OUTRIGHT. They are what the canvass actually
  // rendered, so a match against one is never off-brief and never ambiguous.
  let best: { section: string; offBrief: boolean; length: number; index: number } | null = null;
  for (const section of known) {
    const index = wordIndex(lower, section);
    if (index < 0) continue;
    if (best === null || section.length > best.length) best = { section, offBrief: false, length: section.length, index };
  }
  if (best !== null) return { section: best.section, offBrief: false };
  for (const section of COMMON_SECTIONS) {
    const index = wordIndex(lower, section);
    if (index < 0) continue;
    // LONGEST WINS, then LATEST — "what about a pricing page" is a request for
    // pricing, and the earlier, shorter `about` is the word he used to ask it.
    if (best === null || section.length > best.length || (section.length === best.length && index > best.index)) {
      best = { section, offBrief: true, length: section.length, index };
    }
  }
  return best === null ? null : { section: best.section, offBrief: best.offBrief };
}

/**
 * Turn an owner message into a render request, or null.
 *
 * NULL WHEN NOTHING IN IT PROVES A DIRECTION REFERENCE — the message is then a
 * mid-run instruction rather than a request, `deliver` returns false, and it
 * stays pending for the segment-boundary drain exactly as today. That is the same
 * decision `PlanDriver.#answers` makes when a message predates the questions: a
 * message this driver declines is not lost.
 *
 * A PROVED DIRECTION IS WHAT MAKES IT A REQUEST, NOT THE SECTION, AND NOT A
 * DIRECTION MERELY MENTIONED. "make the hero taller" names a section and is an
 * instruction; so is "editorial slab's type is too big for the hero", which names
 * a section AND a direction. "the hero in 2" and "show me the hero in editorial
 * slab" are questions about the canvass. {@link matchDirectionReference} holds
 * every one of those judgements and the proof each arm demands; this function
 * adds none of its own.
 *
 * A DIRECTION THAT DOES NOT EXIST IS RETURNED WITH `resolved: null` rather than
 * as a null request, so the caller can REFUSE IT BY NAME. Rendering a guess and
 * presenting it as an answer is the one thing this must never do — the owner
 * would take a picture of direction 1 for the direction 4 he asked about.
 */
export function parseDesignRequest(text: string, manifest: DesignManifest): DesignRequest | null {
  const reference = matchDirectionReference(text, manifest.directions);
  // A SECTION ALONE IS NOT A REQUEST, whatever else the sentence contains — and
  // neither is a section beside a direction's NAME. "make the hero taller" and "I
  // like editorial slab, but make the hero taller" are both instructions for the
  // build; only a PROVED reference turns one into a question about the canvass.
  if (reference === null) return null;
  const section = matchSection(text, manifest);
  if (reference.direction === null) {
    // He said "direction 7" or "the fourth" and there is no such thing. Named, so
    // it is a request; unresolved, so it is refused BY NAME rather than guessed.
    return {
      section: section?.section ?? "",
      direction: reference.label,
      resolved: null,
      offBrief: section?.offBrief ?? false,
    };
  }
  const direction = reference.direction;
  if (section === null) {
    return { section: "", direction: direction.slug, resolved: direction, offBrief: false };
  }
  return { section: section.section, direction: direction.slug, resolved: direction, offBrief: section.offBrief };
}

/** True when this run has spent every turn it was given. */
export function designTurnsExhausted(record: DesignLockRecord): boolean {
  return record.turnsUsed >= MAX_DESIGN_LOCK_TURNS;
}

/** True when this run has spent every on-demand generation it was given. */
export function designRendersExhausted(record: DesignLockRecord): boolean {
  return record.rendersUsed >= MAX_DESIGN_ON_DEMAND_RENDERS;
}

export class DesignDialogueDriver {
  readonly #host: DesignDialogueHost;

  /**
   * Runs with a turn in flight.
   *
   * TWO MESSAGES A SECOND APART MUST NOT RUN TWO TURNS: both would read the same
   * `design-lock.json`, and the second write would erase the first's
   * `rendersUsed` while both images had already been generated — a cap defeated
   * by typing quickly. `PlanDriver.#inFlight`'s argument, with money attached.
   */
  readonly #inFlight = new Set<string>();

  constructor(host: DesignDialogueHost) {
    this.#host = host;
  }

  /**
   * An owner message arrived for a run parked on a canvass.
   *
   * TRUE MEANS "THIS RUN WILL READ IT AS A RENDER REQUEST", which is what the
   * route needs to say. The work itself is asynchronous — it generates an image —
   * and the HTTP request must not wait for it.
   *
   * FALSE FOR A MESSAGE THAT TELLS THE BUILD WHAT TO CHANGE, even on a parked
   * run, even when it names a section, and even when it refers to a DIRECTION by
   * any of the five arms: that is a mid-run instruction and it must stay pending
   * for the boundary drain. This is the ONE place this driver differs from
   * `PlanDriver`, whose `deliver` returns true for any message on a parked run —
   * there, every message is a candidate answer; here, only some are requests, and
   * {@link matchDirectionReference} is the whole of that judgement.
   *
   * FALSE IS NOT SILENT, ON ANY ARM. A message that referred to a direction and
   * instructed the build in the same breath is reported on the run log by
   * {@link DesignDialogueDriver.#sayItWasDeclined}, because the tie-break that
   * costs him a render is only cheap if he is told to ask again.
   */
  deliver(runId: string): boolean {
    const record = this.#parked(runId);
    if (record === null) return false;
    const manifest = this.#host.manifest(runId);
    if (manifest === null) return false;
    // THE QUESTION IS ABOUT THE MESSAGE THAT JUST ARRIVED, NOT ABOUT THE QUEUE.
    // CORRECTED 2026-08-03 after an audit reproduced it against `dist`. This
    // used to ask "does ANY eligible pending message parse as a request"
    // (`#requests(...)[0] === undefined`), and the two questions differ the
    // moment another request-shaped message is still pending:
    //
    //   he asks   "show me the hero in editorial slab"   -> a render starts,
    //                                                       ~30s
    //   he types  "I like design 2, but make the hero taller"
    //
    // The older request is still in `#requests`, so `next` was defined, the
    // decline notice was never reached ON ANY OF THE FIVE ARMS, and `http.ts`
    // logged "owner message taken up at the design park as a request to render
    // a section" — an affirmative sentence about a message nothing will render.
    // He then waits out a 30-minute clock for a second picture.
    //
    // The instruction was never actually lost — it stays pending and the build
    // segment sees it — so what the old guard cost was the NOTICE and the truth
    // of the log line. That is still the property this driver's own docblock
    // sells ("FALSE IS NOT SILENT, ON ANY ARM"), and a claim a reader would rely
    // on has to be true rather than usually true.
    //
    // `#sayItWasDeclined` already asked the right question — it picks
    // `eligible[eligible.length - 1]`, the newest, and its docblock says why. So
    // this is ONE rule asked wrongly in ONE place, and the fix belongs here
    // rather than in five arms; gating per-arm is what rounds 2-4 did, and each
    // time a sibling arm survived.
    const declined = this.#newestWasDeclined(runId, record, manifest);
    if (declined) {
      this.#sayItWasDeclined(runId, record, manifest);
      return false;
    }
    const next = this.#requests(runId, record, manifest)[0];
    if (next === undefined) {
      this.#sayItWasDeclined(runId, record, manifest);
      return false;
    }
    void this.#drain(runId);
    return true;
  }

  /**
   * Did the message he just typed refer to a direction AND instruct the build?
   *
   * Shares `#eligible` and `declinedDirectionReference` with
   * {@link DesignDialogueDriver.#sayItWasDeclined} on purpose: the question
   * "should he be told" and the question "what do we tell him" must be answered
   * over the same message and the same arms, or they agree by coincidence — the
   * exact way the old `unaskedDirectionMention`/name-arm pair agreed until four
   * more arms were gated.
   */
  #newestWasDeclined(runId: string, record: DesignLockRecord, manifest: DesignManifest): boolean {
    const eligible = this.#eligible(runId, record);
    const newest = eligible[eligible.length - 1];
    if (newest === undefined) return false;
    return declinedDirectionReference(newest.text, manifest.directions) !== null;
  }

  /**
   * A DECLINE THE OWNER CAN SEE — said once, about the message that just arrived.
   *
   * THE NEWEST ELIGIBLE MESSAGE AND NO OTHER. `deliver` is called once per
   * arrival, so the newest pending message is the one he just typed; reporting
   * every pending near-miss would repeat itself on each later message and bury
   * the one that mattered. An older near-miss that has already been reported has
   * already had its sentence.
   *
   * NOTHING IS CLAIMED, STAMPED OR CHARGED HERE, which is the whole property that
   * makes the parser's tie-break cheap: the message is still pending, the build
   * segment will still see it, `turnsUsed` is untouched, and he can rephrase
   * immediately if a picture is what he wanted.
   */
  #sayItWasDeclined(runId: string, record: DesignLockRecord, manifest: DesignManifest): void {
    const eligible = this.#eligible(runId, record);
    const newest = eligible[eligible.length - 1];
    if (newest === undefined) return;
    const declined = declinedDirectionReference(newest.text, manifest.directions);
    if (declined === null) return;
    const named = declined.direction;
    // A LABEL THIS RUN CANNOT RESOLVE STILL GETS A SENTENCE. "design 7, but make
    // the hero taller" is declined like any other instruction, and saying nothing
    // would leave him waiting for a picture of a direction that never existed.
    const subject =
      named === null
        ? `refers to direction "${declined.label}", which this run does not offer,`
        : `names the "${named.name}" direction,`;
    const ordinal = named === null ? 1 : manifest.directions.findIndex((d) => d.slug === named.slug) + 1;
    // A DIRECTION WHOSE OWN NAME TRIPS THE VETO CANNOT BE ASKED FOR BY NAME, and
    // suggesting it anyway is the docblock-claiming-more defect in one sentence.
    // `BUILD_INSTRUCTION` is matched against the whole message, and `cut` and
    // `drop` are both imperatives — so for a direction the lane called "Cut
    // paper", `show me the hero in cut paper` is declined, and the notice used to
    // answer that by advising the identical sentence. Measured against `dist`
    // with those exact names. The ordinal always works, because it never carries
    // the name, so it leads when the name cannot.
    const nameIsUnusable = named !== null && carriesBuildInstruction(named.name.toLowerCase());
    const rephrase =
      named === null
        ? `"show me the hero in 1"`
        : nameIsUnusable
          ? `"show me the hero in ${String(ordinal)}" — this direction's own name reads as an instruction, ` +
            "so ask for it by number rather than by name"
          : `"show me the hero in ${named.name}" or "show me the hero in ${String(ordinal)}"`;
    this.#host.log(
      runId,
      "warn",
      `this message ${subject} and also tells the build what to change, so it was read as an instruction ` +
        "for the build rather than as a request to render a picture — it cost no turn and no render, it was " +
        "not consumed, and the build segment will still see it. If you also want to SEE a section drawn, " +
        `ask for that on its own: ${rephrase}.`,
    );
  }

  /** True while a render is running for this run. */
  busy(runId: string): boolean {
    return this.#inFlight.has(runId);
  }

  /**
   * Consume every pending request, one render each, until the caps or the park
   * end it.
   *
   * A LOOP AND NOT A SINGLE TURN, `PlanDriver.#drain`'s argument: the route has
   * already answered and a message that arrived while a generation was in flight
   * would otherwise be read by nothing.
   */
  async #drain(runId: string): Promise<void> {
    if (this.#inFlight.has(runId)) return;
    this.#inFlight.add(runId);
    try {
      for (;;) {
        const record = this.#parked(runId);
        if (record === null) return;
        const manifest = this.#host.manifest(runId);
        if (manifest === null) return;
        const entry = this.#requests(runId, record, manifest)[0];
        if (entry === undefined) return;
        const carryOn = await this.#turn(runId, record, entry.message, entry.request);
        if (!carryOn) return;
      }
    } finally {
      this.#inFlight.delete(runId);
    }
  }

  /**
   * The pending messages that are render requests, from the cut onwards.
   *
   * THE CUT IS `PlanRecord.askedAfterSeq`'s TWIN and it exists for the same
   * reason: the oldest undelivered message is often one the owner typed BEFORE
   * the mockups appeared, and consuming it would spend a turn and an image on an
   * instruction — and stamp it delivered, so the builder never saw it either.
   *
   * `null` IS A RECORD FROM BEFORE THE CUT EXISTED (a park in flight across the
   * upgrade) and keeps the old behaviour rather than inventing a boundary.
   */
  #requests(
    runId: string,
    record: DesignLockRecord,
    manifest: DesignManifest,
  ): readonly { message: ChatMessage; request: DesignRequest }[] {
    const out: { message: ChatMessage; request: DesignRequest }[] = [];
    for (const message of this.#eligible(runId, record)) {
      const request = parseDesignRequest(message.text, manifest);
      // A MESSAGE THIS SKIPS IS NOT LOST AND MUST NOT BLOCK THE LOOP — it stays
      // pending and reaches the next build segment, which is exactly how a
      // mid-run instruction travels today.
      if (request !== null) out.push({ message, request });
    }
    return out;
  }

  /**
   * The pending messages from the cut onwards, oldest first — the ONE definition
   * of "a message this park may read", shared by the parse and by the decline
   * notice so the two cannot disagree about which messages exist.
   */
  #eligible(runId: string, record: DesignLockRecord): readonly ChatMessage[] {
    const cut = record.askedAfterSeq;
    const pending = this.#host.pendingMessages(runId);
    return cut === null ? pending : pending.filter((message) => message.seq > cut);
  }

  /** One owner turn. Returns false when the dialogue can take no more. */
  async #turn(
    runId: string,
    record: DesignLockRecord,
    message: ChatMessage,
    request: DesignRequest,
  ): Promise<boolean> {
    const at = new Date().toISOString();
    // EVERY CLAIMED MESSAGE COSTS A TURN, whatever it contained — `plan-state.ts`
    // rule 6. A refusal is a turn the owner spent; pretending otherwise would let
    // an unbounded exchange run on refusals alone.
    const turnsUsed = record.turnsUsed + 1;

    const capped = this.#capRefusal(record, request);
    if (capped !== null) {
      this.#commit(runId, record, {
        turnsUsed,
        rendersUsed: record.rendersUsed,
        request: { seq: message.seq, at, section: request.section, direction: request.direction, ...capped },
      });
      this.#host.markDelivered(runId, [message.seq]);
      this.#host.log(runId, "warn", capped.detail);
      // A CAP REFUSAL ENDS THE DRAIN. Continuing would refuse every remaining
      // message in a burst with the same sentence, burying the one that mattered.
      return false;
    }

    if (request.resolved === null) {
      // REFUSED BY NAME. Never render a guess and present it as an answer.
      const detail =
        `there is no direction "${request.direction}" on this run — the directions offered are ` +
        `${record.directions.map((direction, index) => `${String(index + 1)}. ${direction.name}`).join(", ")}. ` +
        "Nothing was rendered; name one of those and ask again.";
      this.#commit(runId, record, {
        turnsUsed,
        rendersUsed: record.rendersUsed,
        request: {
          seq: message.seq,
          at,
          section: request.section,
          direction: request.direction,
          outcome: "unknown-direction",
          detail,
          path: null,
        },
      });
      this.#host.markDelivered(runId, [message.seq]);
      this.#host.log(runId, "warn", detail);
      return true;
    }

    if (request.section.trim().length === 0) {
      const detail =
        `"${request.resolved.name}" is a direction I can render, but the message names no section. ` +
        "Say which part of the page you want to see — the hero, the contact section, the footer. " +
        "Nothing was rendered.";
      this.#commit(runId, record, {
        turnsUsed,
        rendersUsed: record.rendersUsed,
        request: {
          seq: message.seq,
          at,
          section: "",
          direction: request.direction,
          outcome: "no-section",
          detail,
          path: null,
        },
      });
      this.#host.markDelivered(runId, [message.seq]);
      this.#host.log(runId, "warn", detail);
      return true;
    }

    const result = await this.#host.render(runId, request);

    // RE-CHECKED AFTER THE AWAIT, `PlanDriver.#turn`'s argument. `cancel()` can
    // finish the row TERMINAL while a generation is in flight, and writing the
    // record onto a cancelled run would leave a terminal run holding an open
    // dialogue. THE SAME AUTHORITY as the entry check, so a park closed by the
    // timer mid-render is caught here too.
    const still = this.#parked(runId);
    if (still === null) {
      // THE GENERATION IS STILL CHARGED, AND THAT IS THE WHOLE POINT OF THIS ARM.
      // Returning here before `#commit` left an image that was generated and paid
      // for counted against NEITHER cap — so a park that reopened for any reason
      // handed the owner a fresh budget with the money already gone. Measured
      // 2026-08-03; the caps bound SPEND, and the spend happened.
      //
      // ONTO THE RECORD AS IT IS NOW, NEVER THE ONE THIS TURN STARTED FROM. What
      // closed the park usually WROTE this file — `#applyDirectionChoice` sets
      // `awaiting: false` and the chosen direction — and spreading the entry-time
      // record over that would reopen a closed park and erase the owner's choice.
      const closed = readDesignLock(this.#host.resultsDir(runId));
      if (closed !== null) {
        this.#commit(runId, closed, {
          turnsUsed: closed.turnsUsed + 1,
          // AND STILL ONLY WHAT WAS ACTUALLY RUN. The park closing under a
          // request does not turn a generation nobody attempted into a spend —
          // a degraded park whose window lapses mid-answer charges for nothing,
          // exactly as it does when the park is still open.
          rendersUsed: closed.rendersUsed + (result.attempted ? 1 : 0),
          request: {
            seq: message.seq,
            at,
            section: request.section,
            direction: request.direction,
            outcome: result.outcome,
            detail: result.detail,
            path: result.path,
          },
        });
      }
      // NOT STAMPED, deliberately, and it is the one place this differs from the
      // path below. The park is closed, so this message is about to be read by the
      // BUILD segment instead; stamping it would consume a sentence the run can
      // still act on, and an unread instruction is the loss that cannot be undone.
      this.#host.log(
        runId,
        "warn",
        "this run left the design park while a render was in flight — cancelled, chosen, or the window " +
          "expired — so the still was generated, charged against the caps, and recorded against a park " +
          "that had already closed",
      );
      return false;
    }

    // A FAILED GENERATION STILL SPENDS ITS RENDER WHEN IT WAS ACTUALLY RUN, and
    // that is deliberate rather than harsh: the call was made and the money was
    // spent. Counting only successes would make the cap a bound on luck.
    //
    // A REQUEST THAT NEVER REACHED THE TOOL SPENDS NOTHING, which is the other
    // half of the same rule and was missing until 2026-08-03: a degraded park
    // answers "there is no image generation on this machine" without invoking
    // anything, and charging that a render bounded the wrong thing — six honest
    // refusals and the panel would have told the owner his budget was gone.
    // `DesignRenderResult.attempted` is the host's own answer to "was a call
    // made", never inferred from `outcome`. THE TURN IS SPENT EITHER WAY: he
    // asked and the park answered him, which is `plan-state.ts` rule 6.
    this.#commit(runId, still, {
      turnsUsed,
      rendersUsed: still.rendersUsed + (result.attempted ? 1 : 0),
      request: {
        seq: message.seq,
        at,
        section: request.section,
        direction: request.direction,
        outcome: result.outcome,
        detail: result.detail,
        path: result.path,
      },
    });
    // WRITTEN BEFORE THE STAMP, `plan-dialogue.ts`'s ordering: a crash between the
    // two must lose the STAMP, not the record of a generation that was paid for.
    this.#host.markDelivered(runId, [message.seq]);
    this.#host.log(runId, result.outcome === "failed" ? "warn" : "info", result.detail);
    return true;
  }

  /** The cap refusal this request runs into, or null when it may proceed. */
  #capRefusal(
    record: DesignLockRecord,
    request: DesignRequest,
  ): { outcome: DesignRenderOutcome; detail: string; path: null } | null {
    if (designTurnsExhausted(record)) {
      return {
        outcome: "turn-cap",
        detail:
          `no more questions on this run — ${String(MAX_DESIGN_LOCK_TURNS)} were used. ` +
          `Pick one of the directions to carry forward. ${DESIGN_FROZEN_SUITE_NOTICE}`,
        path: null,
      };
    }
    if (designRendersExhausted(record)) {
      return {
        outcome: "render-cap",
        detail:
          `no more renders on this run — ${String(MAX_DESIGN_ON_DEMAND_RENDERS)} were generated. ` +
          `"${request.section || "that section"}" was not drawn. Pick one of the directions to carry forward.`,
        path: null,
      };
    }
    return null;
  }

  /**
   * Write the turn into `design-lock.json`, SPREADING onto the record we read.
   *
   * NEVER A FRESH LITERAL. The park's `parkedAt`, its `awaiting`, its mirrored
   * `directions` and every earlier request all live in this file, and rebuilding
   * it here would reset the clock the whole bound rests on.
   */
  #commit(
    runId: string,
    record: DesignLockRecord,
    turn: { turnsUsed: number; rendersUsed: number; request: DesignRenderRequest },
  ): void {
    writeDesignLock(this.#host.resultsDir(runId), {
      ...record,
      turnsUsed: turn.turnsUsed,
      rendersUsed: turn.rendersUsed,
      requests: [...record.requests, turn.request],
    });
  }

  /**
   * The record IF this run is still parked on a canvass with no choice made.
   *
   * ONE AUTHORITY, ASKED THE SAME WAY EVERYWHERE — `PlanDriver.#parked`'s
   * argument, and the same three-part question:
   *
   *   the ROW   knows whether the run is still parked at all (cancelled,
   *             expired, resumed by hand).
   *   the RECORD knows whether the park is open.
   *   the MANIFEST knows whether it is a CANVASS park — a run parked for a MOCKUP
   *             on a single-direction lane is `awaiting_input` with an
   *             `awaiting: true` record too, and its owner has nothing to ask for.
   *
   * THE EXPIRED CASE IS DELIBERATELY NOT CHECKED HERE. The timer that ends the
   * park is `#parkForDesignLock`'s and it PROCEEDS — it resumes the run, which
   * flips the row out of `awaiting_input` and closes this driver on the next
   * question. A second expiry test here could only disagree with it.
   */
  #parked(runId: string): DesignLockRecord | null {
    const row = this.#host.getRun(runId);
    if (row === null || isTerminal(row.status) || row.status !== "awaiting_input") return null;
    const record = readDesignLock(this.#host.resultsDir(runId));
    if (record === null || !record.awaiting) return null;
    const manifest = this.#host.manifest(runId);
    if (manifest === null || manifest.directions.length === 0 || manifest.chosenDirection !== null) return null;
    return record;
  }

  /**
   * Whether this run's park has already lapsed, for a caller that needs to say so.
   *
   * EXPORTED RATHER THAN USED HERE, and the split is the point: `designLockExpired`
   * decides an expiry the same way on both paths that can end one (the live timer
   * and `reconcileOnBoot`), and this driver is neither. It is here so a caller can
   * ask the question without a second reading of the timeout.
   */
  expired(runId: string): boolean {
    const record = readDesignLock(this.#host.resultsDir(runId));
    if (record === null) return false;
    return designLockExpired(record.parkedAt, new Date().toISOString(), designLockTimeoutMin(this.#host.env));
  }
}
