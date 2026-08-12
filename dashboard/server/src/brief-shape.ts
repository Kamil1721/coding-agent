/**
 * brief-shape.ts — the ticket brief read at SUBMISSION, deterministically, in
 * milliseconds, for nothing.
 *
 * WHAT FORCED IT. Run `dfd5a050` (2026-08-10) carried a brief whose motion
 * section opened "A reading of a reference page's motion is attached to this
 * ticket", and its `references.json` recorded `motion: null` — no reading was
 * ever attached, because the request named no page to read. Nothing refused it.
 * The promise went into the acceptance suite as a criterion about an artefact
 * that did not exist, and the cost of noticing at SPEC time rather than at
 * submission was measured in HOURS of a spec phase the owner paid for. This
 * module is that same observation moved to the one place it is free: the POST
 * that has the brief and the manifest in the same function, before a run id is
 * minted or a byte is written.
 *
 * ONE RULE BLOCKS AND THREE ADVISE, and the split is not a matter of taste.
 * `dangling_attachment` compares a CLAIM IN THE PROSE against the request's OWN
 * MANIFEST — two things this process holds, both provable, no model asked and no
 * judgement exercised. It can therefore be a 400. The other three are readings of
 * English and are reported as warnings on the 201: a rule that guesses must never
 * be able to refuse the owner's work.
 *
 * THE PRECISION BIAS IS DELIBERATE AND IT POINTS ONE WAY. The blocking rule
 * requires the KIND WORD and the ATTACHMENT ASSERTION to be adjacent (see
 * {@link SLOT_RULES}) rather than merely co-occurring in one sentence. That
 * under-detects: "please find the CV, attached" is not caught. Under-detecting
 * costs a spec phase the pipeline was already paying for; over-detecting refuses
 * a brief that was fine, at the submit button, with the owner watching. Those two
 * errors are not the same size.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not call a model, read a file, touch the
 * network or the clock, or look at anything but the two arguments it is given —
 * that is what makes it safe to run before the run exists. It does not judge
 * whether a brief is GOOD; three of its four rules are about sentences the spec
 * seat's own validator (`bakeoff/src/spec-validate.ts`) would later refuse in a
 * criterion, told to the owner while the brief is still an editable textarea.
 *
 * THE TWO PATTERN LISTS ARE THE GRADER'S OWN, IMPORTED, NOT COPIED. See
 * {@link WEAK_MODAL_PATTERN} and {@link SCALE_PATTERNS} in `spec-validate.ts`:
 * they are the list a criterion is blocked or flagged against downstream, and a
 * second definition of "what counts as a weak modal" that drifted from it would
 * warn about briefs the grader accepts and stay silent on briefs it refuses. This
 * repository keeps finding that defect; it is not going to be introduced here for
 * two regular expressions.
 */

import { SCALE_PATTERNS, WEAK_MODAL_PATTERN } from "bakeoff/dist/spec-validate.js";

export interface BriefShapeFinding {
  readonly code: "dangling_attachment" | "multi_obligation" | "weak_modal" | "scale_language";
  readonly blocking: boolean;
  /** The offending sentence, verbatim and untrimmed of meaning. */
  readonly sentence: string;
  readonly detail: string;
  readonly remediation: string;
}

/**
 * What this request actually carries, as the intake routes know it.
 *
 * COUNTS FOR THE TWO THAT ARRIVE AS ARRAYS, BOOLEANS FOR THE TWO THAT ARE
 * READINGS. `images` and `documents` are decoded attachments and their number is
 * known exactly. `motion` and `capture` are page readings that the route will
 * ATTEMPT after this check runs, so the only honest thing a caller can say here
 * is whether one was asked for at all — see the wiring in `http.ts`, which
 * documents which way it erred.
 */
export interface BriefAttachments {
  readonly images: number;
  readonly documents: number;
  readonly motion: boolean;
  readonly capture: boolean;
}

type AttachmentSlot = "images" | "documents" | "motion" | "capture";

interface SlotRule {
  readonly slot: AttachmentSlot;
  /** How the finding names the missing thing, in the owner's words. */
  readonly noun: string;
  /** What the owner would have to do to make the sentence true. */
  readonly fix: string;
  /** Words for this kind of attachment, as a regex alternation source. */
  readonly kinds: string;
}

/**
 * The four attachment slots and the words a brief uses for them.
 *
 * VOCABULARY, NOT SEMANTICS. Each entry is the set of nouns the owner's own
 * briefs use for one slot; nothing here understands English. `design` and
 * `reading` are the two risky members — both are ordinary words — and they are
 * safe only because of the adjacency requirement in {@link namesSlot}: "the
 * attached design" names a slot, "the attached CV describes the design" does not.
 *
 * `reading` IS A TERM OF ART IN THIS SYSTEM. `motion-capture.ts` calls its output
 * a motion READING and the owner's briefs say "the attached reading", so it
 * belongs to the motion slot even though the word alone is generic. It is scoped
 * by the same adjacency rule as everything else.
 */
const SLOT_RULES: readonly SlotRule[] = Object.freeze([
  {
    slot: "images",
    noun: "an image",
    fix: "attach the image",
    kinds: "images?|screenshots?|screen[ -]?grabs?|mock-?ups?|pictures?|photos?|designs?",
  },
  {
    slot: "documents",
    noun: "a document",
    fix: "attach the document",
    kinds: "cvs?|r[eé]sum[eé]s?|documents?|docs?|pdfs?|spec sheets?|briefs?",
  },
  {
    slot: "motion",
    noun: "a motion reading",
    fix: "send motionUrl so the page's motion is actually read",
    kinds: "motions?|motion readings?|motion captures?|readings?|videos?|recordings?|screen recordings?",
  },
  {
    slot: "capture",
    noun: "a page capture",
    fix: "send captureUrl, or leave the page's URL in the brief so it is captured",
    kinds: "captured pages?|page captures?|site captures?|snapshots? of the page|page snapshots?",
  },
]);

/**
 * The sentence asserts that SOMETHING IS ATTACHED.
 *
 * The gate for the whole blocking rule, and it is deliberately the narrow
 * English: "attached", "attachment", "attachments". An imperative "attach the
 * CV" is an INSTRUCTION about the future, not a claim about this request, and
 * the `(?:ed|ment|ments)` suffix is what keeps the two apart.
 */
const ATTACHMENT_ASSERTION = /\battach(?:ed|ment|ments)\b/gi;

/**
 * A NEGATED attachment word, which is the opposite of a promise.
 *
 * MEASURED, NOT IMAGINED. Without this the rule refused
 * `supervisor-route.test.ts`'s own control brief — "no attachments here", filed
 * with nothing attached — as a dangling promise. The sentence says exactly what
 * the manifest says; reading it as a claim is the rule contradicting a brief that
 * agrees with it.
 *
 * The window is the 24 characters before the attachment word, which covers "no",
 * "not", "without", "nothing" and a short object between them. It also swallows
 * "do not use the attached image", where something IS attached — under-detecting,
 * again in the safe direction: nothing is refused that should not be.
 */
const ATTACHMENT_NEGATION =
  /\b(?:no|not|never|without|nothing|none|neither|zero|ignore|ignoring|disregard)\b[^.]{0,24}$/i;

/**
 * A denial that FOLLOWS the attachment word.
 *
 * MEASURED 2026-08-12, AND IT WAS A FALSE REFUSAL. The guard above reads only
 * the text BEFORE the word, so `"Attached: none."` — a brief saying exactly what
 * its manifest says — was answered with a 400. On a rule that refuses the
 * owner's work at the submit button that is the one error direction this module
 * is not allowed to make.
 *
 * DELIBERATELY NARROWER THAN ITS TWIN: the bare denials only, never `not`.
 * "The attached CV is not optional" is a real promise with a `not` after the
 * word, and a symmetric rule would silence it. Silencing a real promise costs a
 * spec phase; refusing a true brief costs the owner's trust in the check.
 */
const ATTACHMENT_DENIAL_AFTER = /^\W{0,3}(?:none|nothing|n\/a)\b/i;

function assertsAttachment(sentence: string): boolean {
  ATTACHMENT_ASSERTION.lastIndex = 0;
  let match = ATTACHMENT_ASSERTION.exec(sentence);
  while (match !== null) {
    const before = sentence.slice(0, match.index);
    const after = sentence.slice(match.index + match[0].length);
    if (!ATTACHMENT_NEGATION.test(before) && !ATTACHMENT_DENIAL_AFTER.test(after)) return true;
    match = ATTACHMENT_ASSERTION.exec(sentence);
  }
  return false;
}

/** A word, for the purpose of counting how far a kind sits from "attached". */
const WORD = String.raw`[\w'’-]+`;

/**
 * Determiners that point at ONE specific thing rather than quantifying a class.
 *
 * Deliberately excludes `a`, `an`, `each`, `every`, `any`, `some` and the bare
 * plural — those are how a brief describes a FEATURE that handles attachments,
 * and treating them as claims is what refused seven legitimate sentences on
 * 2026-08-12. See {@link namesSlot}.
 */
const DEICTIC = "the|this|that|these|those|my|our|its|his|her|their";

/**
 * An attachment reference that points at ONE thing, with no kind named.
 *
 * The gate for the no-kind arm, and it needs the same deixis the kinded arm
 * needs. "See the attachment" is a claim about this request. *"An attachment
 * larger than 10 MB is rejected with a clear message"* is a size limit in a
 * product, and it was refused on 2026-08-12 for containing the word.
 */
const DEICTIC_ATTACHMENT = new RegExp(
  String.raw`\b(?:${DEICTIC})\s+attach(?:ment|ments)\b|\b(?:is|are|was|were)\s+attached\b`,
  "i",
);

/**
 * Does this sentence name this slot AS THE THING THAT IS ATTACHED?
 *
 * TWO SHAPES, AND CO-OCCURRENCE IS NOT ONE OF THEM.
 *
 *   A. "the attached CV", "the attached reference image", "I have attached the
 *      screenshot" — the kind follows `attached` within two words.
 *   B. "a reading of a reference page's motion is attached to this ticket" — the
 *      kind precedes a copula plus `attached`, within one clause.
 *
 * The two-word window in A is the measurement that matters: at three words "the
 * attached brief describes the design system" starts naming the IMAGE slot and a
 * brief with no images attached would be refused for a sentence about typography.
 */
function namesSlot(sentence: string, rule: SlotRule): boolean {
  /*
   * THE CLAIM MUST POINT AT A SPECIFIC THING, NOT DESCRIBE A CLASS OF THINGS.
   *
   * MEASURED 2026-08-12, AND IT REFUSED SEVEN LEGITIMATE SENTENCES. The arm was
   * `attach(?:ed|ments?)` + up to two words + a kind, which fires on any prose
   * ABOUT attachments — and a brief for software that handles uploads is full of
   * it. With three images, two documents and a page capture all attached:
   *
   *     "Each attached video shall be transcoded to MP4 on upload."      -> 400
   *     "The gallery lists attached videos newest first."                -> 400
   *     "Deleting an attachment removes the recording from storage."     -> 400
   *     "The panel shall list attached documents in a table."            -> 400
   *
   * Every one of those describes the PRODUCT. None is a claim about what came
   * with this request, and refusing them means this dashboard cannot accept a
   * ticket for any app with a file upload — at the submit button, with the owner
   * watching, which is the error direction this module's header forbids.
   *
   * THE DISTINGUISHER IS DEIXIS. A brief claiming an attachment points at one:
   * *the* attached CV, *this* attached image, "I have attached *the* screenshot".
   * Prose about a feature quantifies over a class: *each* attached video,
   * *an* attachment, bare-plural *attached documents*. So the kind must sit
   * beside a DEFINITE or POSSESSIVE determiner, on one side or the other. The
   * copula arm below is unaffected — "a reading … is attached to this ticket"
   * carries its own deixis in "this ticket".
   */
  const attachedThenKind = new RegExp(
    // "the attached CV", "this attached reference image"
    String.raw`\b(?:${DEICTIC})\s+attach(?:ed|ments?)\b(?:\s+${WORD}){0,2}\s+(?:${rule.kinds})\b` +
      // "I have attached the screenshot"
      String.raw`|\battached\s+(?:${DEICTIC})\s+(?:${WORD}\s+){0,1}(?:${rule.kinds})\b`,
    "i",
  );
  const kindThenAttached = new RegExp(
    String.raw`\b(?:${rule.kinds})\b[^.]{0,60}?\b(?:is|are|was|were)\s+attached\b`,
    "i",
  );
  return attachedThenKind.test(sentence) || kindThenAttached.test(sentence);
}

/** Does the sentence name ANY attachment kind, wherever it sits? */
function namesAnyKind(sentence: string): boolean {
  return SLOT_RULES.some((rule) => new RegExp(String.raw`\b(?:${rule.kinds})\b`, "i").test(sentence));
}

function slotIsEmpty(slot: AttachmentSlot, attachments: BriefAttachments): boolean {
  switch (slot) {
    case "images":
      return attachments.images === 0;
    case "documents":
      return attachments.documents === 0;
    case "motion":
      return !attachments.motion;
    case "capture":
      return !attachments.capture;
  }
}

/** True when the request carries NOTHING — the only case the no-kind arm may fire in. */
function carriesNothing(attachments: BriefAttachments): boolean {
  return attachments.images === 0 && attachments.documents === 0 && !attachments.motion && !attachments.capture;
}

/**
 * The remediation, and it is the same sentence for every slot on purpose.
 *
 * The owner has two fixes and both are cheap; what he must not do is leave the
 * sentence and hope. It says so, with the reason, because "dangling_attachment"
 * alone reads like a parser complaint rather than a statement about what the run
 * will do with the promise.
 */
function danglingRemediation(fixes: readonly string[]): string {
  return (
    `Either ${fixes.join(", or ")} — or delete the sentence. ` +
    "A brief that promises an attachment the run does not have becomes an acceptance criterion nobody " +
    "can satisfy: the spec seat writes the promise into the frozen suite, the builder has nothing to " +
    "build it from, and the run is graded against an artefact that was never sent."
  );
}

/* -------------------------------------------------------------------------
 * Cutting a brief into sentences
 * ---------------------------------------------------------------------- */

interface BriefSentence {
  /** An exact substring of the brief. Hard wrapping means it may contain newlines. */
  readonly text: string;
  /** The heading in force where it sits, or "" above the first one. */
  readonly heading: string;
}

/**
 * A heading line: no lower-case letter, at least one upper-case one.
 *
 * The owner's briefs head their sections in caps ("HOW I WILL KNOW IT WORKS",
 * "--- WHAT IS DIFFERENT THIS TIME ---") rather than in markdown, so that is what
 * is detected; a leading `#` is accepted too because a brief pasted out of a
 * markdown editor is the obvious other case. Prose never matches: one lower-case
 * letter anywhere on the line disqualifies it, and a shouted word inside a
 * sentence ("rendered STRETCHED") shares its line with ordinary text.
 */
const HEADING_LINE = /^(?:#{1,6}\s+\S|[^a-z]*[A-Z][^a-z]*$)/;

/** A bullet starts a new unit: two bullets are two thoughts, not one sentence. */
const BULLET_LINE = /^\s*(?:[-*•]|\d+[.)])\s+\S/;

/** Sentence end: terminal punctuation followed by whitespace or the end of the text. */
const SENTENCE_END = /[.!?]["')\]]?(?=\s|$)/g;

/**
 * Cut the brief into sentences, each tagged with the heading above it.
 *
 * VERBATIM SUBSTRINGS, AND THAT IS A REQUIREMENT RATHER THAN AN ACCIDENT. A
 * finding quotes the sentence back to the owner in a 400, and a quote he cannot
 * find in his own textarea by searching for it is a worse error message than no
 * quote at all. Only leading and trailing whitespace is removed; internal line
 * breaks from hard wrapping are kept, so `brief.includes(finding.sentence)` holds
 * for every finding this module produces (`brief-shape.test.ts` asserts it).
 *
 * HEADINGS ARE SENTENCES TOO. A heading is scanned like any other text so that a
 * rule which applies "anywhere" — `scale_language` — has no blind spot in the
 * one part of the brief the owner writes in capitals.
 */
function sentencesOf(brief: string): readonly BriefSentence[] {
  const out: BriefSentence[] = [];
  let heading = "";
  let unit: string[] = [];

  const flush = (): void => {
    if (unit.length === 0) return;
    const block = unit.join("\n");
    unit = [];
    let cursor = 0;
    SENTENCE_END.lastIndex = 0;
    let match = SENTENCE_END.exec(block);
    while (match !== null) {
      const end = match.index + match[0].length;
      const text = block.slice(cursor, end).trim();
      if (text.length > 0) out.push({ text, heading });
      cursor = end;
      match = SENTENCE_END.exec(block);
    }
    // The tail: a block that does not end in punctuation is still a sentence —
    // bullet lists and headings routinely have no full stop.
    const tail = block.slice(cursor).trim();
    if (tail.length > 0) out.push({ text: tail, heading });
  };

  for (const line of brief.split("\n")) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (HEADING_LINE.test(line)) {
      flush();
      heading = line.trim();
      out.push({ text: heading, heading });
      continue;
    }
    if (BULLET_LINE.test(line)) flush();
    unit.push(line);
  }
  flush();
  return out;
}

/* -------------------------------------------------------------------------
 * The advisory rules
 * ---------------------------------------------------------------------- */

/**
 * A sentence that carries a REQUIREMENT, which is a much smaller set than "a
 * sentence in the brief".
 *
 * Two ways in, and both are structural: the EARS verb (" shall ") that
 * `spec-validate.ts` requires of every criterion, or a position under a heading
 * where the owner is listing how he will judge the work. Ordinary prose is
 * neither, and that is the whole defence of the `multi_obligation` rule below —
 * "Take the roles, dates, projects, skills and contact details from it." is a
 * five-item list in a sentence and must never be flagged, and it is not flagged
 * because it carries no `shall` and sits under no acceptance heading.
 */
const REQUIREMENT_HEADING = /how i will know|acceptance|criteria/i;
const SHALL = /\sshall\s/i;

function requirementBearing(sentence: BriefSentence): boolean {
  return SHALL.test(sentence.text) || REQUIREMENT_HEADING.test(sentence.heading);
}

/** Joins that MIGHT separate two obligations. Whether they do is decided per-join. */
const CLAUSE_JOIN = /;|\band\b/gi;
const STRONG_MODAL = /\b(?:shall|must)\b/i;
/** A predicate-shaped token: a verb inflection, three letters or more. */
const PREDICATE_TOKEN = /^[A-Za-z][A-Za-z'’-]{2,}(?:s|ed|ing)$/;

/**
 * How many separate obligations one sentence carries.
 *
 * WHAT IT ACTUALLY COUNTS, stated plainly because the name promises more than
 * the mechanism delivers: it counts CLAUSE JOINS — every `;`, and every `and`
 * whose remainder either contains a strong modal ("…, and shall stop all of
 * it") or begins with a verb-shaped word ("…and stores nothing"). Obligations
 * are one more than the joins found.
 *
 * IT DOES NOT UNDERSTAND NOUN LISTS. "the roles, dates, projects, skills and
 * contact details" scores 1 here only because `contact` is not verb-shaped, and
 * "Cover the 400 …, the 201, both 401s, the 429, and survival of data" would
 * score 1 for the same brittle reason. Neither sentence is safe BECAUSE of this
 * function — both are excluded by {@link requirementBearing} before it is ever
 * called, and that is the guard to keep if this one is ever changed.
 *
 * MEASURED ON THE OWNER'S OWN BRIEFS. "Submitting the contact form with a blank
 * message shows a field error and stores nothing; GET /api/messages with the
 * right token proves the count did not change." scores 3 — a semicolon plus a
 * verb-shaped `and` — and it really is three separate things to check. "The site
 * shall actually run whatever motion it declares, and shall stop all of it when
 * prefers-reduced-motion is set." scores 2 and stays silent, which is the arm
 * that proves the counter is counting rather than firing.
 */
function obligationCount(sentence: string): number {
  let joins = 0;
  CLAUSE_JOIN.lastIndex = 0;
  let match = CLAUSE_JOIN.exec(sentence);
  while (match !== null) {
    if (match[0] === ";") {
      joins += 1;
    } else {
      const rest = sentence.slice(match.index + match[0].length);
      const words = rest.trim().split(/\s+/, 2);
      const predicateFollows = words.some((word) => PREDICATE_TOKEN.test(word.replace(/[^\w'’-]/g, "")));
      if (STRONG_MODAL.test(rest) || predicateFollows) joins += 1;
    }
    match = CLAUSE_JOIN.exec(sentence);
  }
  return joins + 1;
}

/**
 * Three, because two is how English joins a pair and three is where a reader
 * starts losing track of which half failed. A criterion carrying three
 * obligations is graded as one line: it passes only if all three hold, and when
 * it fails nothing says which.
 */
const MULTI_OBLIGATION_THRESHOLD = 3;

/* -------------------------------------------------------------------------
 * The check
 * ---------------------------------------------------------------------- */

/**
 * Read a brief against what the request carries.
 *
 * Findings come back IN DOCUMENT ORDER, so a caller that refuses on the first
 * blocking one quotes the first broken promise the owner would find himself
 * reading top to bottom. Pure: same brief, same manifest, same answer, always.
 */
export function briefShape(brief: string, attachments: BriefAttachments): readonly BriefShapeFinding[] {
  const findings: BriefShapeFinding[] = [];

  for (const sentence of sentencesOf(brief)) {
    const text = sentence.text;

    if (assertsAttachment(text)) {
      const named = SLOT_RULES.filter((rule) => namesSlot(text, rule));
      const empty = named.filter((rule) => slotIsEmpty(rule.slot, attachments));
      if (empty.length > 0) {
        findings.push({
          code: "dangling_attachment",
          blocking: true,
          sentence: text,
          detail:
            `the brief says ${empty.map((rule) => rule.noun).join(" and ")} is attached, and this request ` +
            `carries none: "${text}"`,
          remediation: danglingRemediation(empty.map((rule) => rule.fix)),
        });
      } else if (
        named.length === 0 &&
        !namesAnyKind(text) &&
        // DEIXIS HERE TOO — see DEICTIC_ATTACHMENT. Without it this arm fires on
        // any sentence carrying the word, which refused "An attachment larger
        // than 10 MB is rejected with a clear message" on an empty request.
        DEICTIC_ATTACHMENT.test(text) &&
        carriesNothing(attachments)
      ) {
        // THE NO-KIND ARM, AND IT IS THE NARROWEST ONE ON PURPOSE. "See the
        // attachment" names nothing, so the only request it can be checked
        // against is one carrying nothing whatsoever — where the claim is false
        // however it is read. With a single image attached this sentence is
        // unfalsifiable and stays silent.
        findings.push({
          code: "dangling_attachment",
          blocking: true,
          sentence: text,
          detail: `the brief refers to an attachment and this request carries nothing at all: "${text}"`,
          remediation: danglingRemediation(["attach the file the sentence means"]),
        });
      }
    }

    const requirement = requirementBearing(sentence);

    if (requirement && obligationCount(text) >= MULTI_OBLIGATION_THRESHOLD) {
      findings.push({
        code: "multi_obligation",
        blocking: false,
        sentence: text,
        detail: `this requirement carries ${String(obligationCount(text))} separate obligations in one sentence`,
        remediation:
          "Split it into one sentence per obligation. Graded as one line it passes only if every part " +
          "holds, and when it fails the verdict cannot say which part did.",
      });
    }

    if (requirement && WEAK_MODAL_PATTERN.test(text)) {
      findings.push({
        code: "weak_modal",
        blocking: false,
        sentence: text,
        detail: "this requirement uses a weak modal (should/may/might/could/ideally/preferably)",
        // THE DOWNSTREAM CONSEQUENCE, NOT A STYLE NOTE. `spec-validate.ts`
        // flags the same word in a criterion, so this sentence is on its way to
        // being rewritten by the spec seat or flagged by the auditor either way.
        remediation:
          'Say "shall" where you mean it and drop the sentence where you do not. A requirement that only ' +
          "should happen cannot be graded: nothing decides whether it did.",
      });
    }

    if (SCALE_PATTERNS.some((pattern) => pattern.test(text))) {
      findings.push({
        code: "scale_language",
        blocking: false,
        sentence: text,
        detail: "this asks for a rating on a scale rather than a yes/no outcome",
        remediation:
          "State the threshold you actually want (\"at least 90\", \"under 200 ms\") or the behaviour you " +
          "want to see. Nobody, including the grader, knows what to do with a 3 out of 5.",
      });
    }
  }

  return findings;
}
