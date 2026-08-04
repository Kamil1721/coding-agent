/**
 * message-markup.test.ts — the citation leak, and the two ways of fixing it wrong.
 *
 * THE DEFECT, AS THE OWNER SAW IT. `dashboard/data/runs.db` holds one row whose
 * text carries `<cite index="…">` around the substance of the answer. It was
 * stored as prose and rendered as prose, angle brackets and all, in the chat panel
 * he was reading. {@link LEAKED} below is that row's text, copied out of SQLite
 * character for character — including the `—` em dashes, the `–` en dash in
 * "1–7", and the `…` that `plan-turn.ts:356` appended when it cut the seat's reply
 * at 400 characters.
 *
 * THERE ARE TWO WAYS TO "FIX" THIS AND BOTH ARE WORSE THAN THE BUG, so both have
 * a test pointed at them:
 *
 *   1. DELETE THE TAG AND ITS CONTENTS. The seven build steps inside the `<cite>`
 *      ARE the answer; a message that loses them says "real section, not
 *      decoration" and never says what the section contains. The first test
 *      asserts every one of those seven words-groups is still there.
 *   2. STRIP EVERY ANGLE-BRACKET SPAN. Then a run explaining that it changed a
 *      `<div>` to a `<section>` reports that it changed a  to a , and a ticket
 *      about React reads as gibberish. The second test is a `run` row full of
 *      legitimate element names, and it is the control that goes red the moment
 *      the rule stops being an allowlist.
 *
 * WHAT EACH TEST'S MUTATION IS, RUN AND RECORDED. Every test below names the edit
 * to `message-markup.ts` or `db.ts` that makes it fail; those edits were applied,
 * watched red, and reverted. A check that can only observe success is this
 * repository's signature defect and is not being added by the file that closes a
 * rendering bug.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RunStore } from "./db.js";
import { ANNOTATION_TAGS, stripAnnotationMarkup } from "./message-markup.js";

/**
 * The real stored text, verbatim from `dashboard/data/runs.db`:
 *
 *   select text from messages
 *   where run_id = 'run-2026-08-04T11-08-10-487Z-162b186d' and seq = 19
 *
 * NOT PARAPHRASED AND NOT SHORTENED. A fixture invented to suit the regex proves
 * the regex matches the fixture. This is the string the owner actually read.
 */
const LEAKED =
  'Taking it: real section, not decoration. /about gets a "HOW I BUILD" flow using the CV\'s seven build bullets — ' +
  '<cite index="1-6,1-8,1-11,1-13,1-15,1-18,1-22">Environment first, Named specialists, Skills read at run time, ' +
  "Hooks on every write, Adversarial review, /debugfix, db-scale-audit</cite> — each with a circled digit 1–7, " +
  "one line of copy, and hand-drawn curved arrows between consecutive ste…";

/** Every phrase inside the tag. Losing any one of them is losing the answer. */
const CITED_PROSE = [
  "Environment first",
  "Named specialists",
  "Skills read at run time",
  "Hooks on every write",
  "Adversarial review",
  "/debugfix",
  "db-scale-audit",
] as const;

function store(name: string): { store: RunStore; file: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `dash-markup-${name}-`));
  const file = join(dir, "runs.db");
  const opened = RunStore.open(file);
  return {
    store: opened,
    file,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The text as SQLite holds it, read PAST the store's mapper.
 *
 * Going through `RunStore.messages` here would be circular: it is the thing under
 * test, and it would report its own output as the stored value.
 */
function storedText(file: string, runId: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT text FROM messages WHERE run_id = ? ORDER BY seq ASC").get(runId);
    assert.ok(row !== undefined, `no message row for ${runId}`);
    const value = row["text"];
    assert.equal(typeof value, "string");
    return value as string;
  } finally {
    db.close();
  }
}

function seed(target: RunStore, runId: string): void {
  target.createRun({
    runId,
    ticketId: `t-${runId}`,
    ticketTitle: runId,
    ticketText: "a portfolio page",
    ticketSha256: "c".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });
}

/* -------------------------------------------------------------------------
 * 1. THE MEASURED LEAK
 * ---------------------------------------------------------------------- */

test("THE LEAKED ROW: the citation markup is gone and every word it wrapped is still there", () => {
  const cleaned = stripAnnotationMarkup(LEAKED);

  // The markup, in all three of its spellings.
  assert.ok(!cleaned.includes("<cite"), `an opening cite tag survived: ${cleaned}`);
  assert.ok(!cleaned.includes("</cite>"), `a closing cite tag survived: ${cleaned}`);
  assert.ok(
    !cleaned.includes('index="1-6,1-8,1-11,1-13,1-15,1-18,1-22"'),
    `the attribute survived: ${cleaned}`,
  );

  // THE HALF THAT MATTERS MORE. A fix that deleted the cited span would pass every
  // assertion above and destroy the message.
  for (const phrase of CITED_PROSE) {
    assert.ok(cleaned.includes(phrase), `the cited prose lost "${phrase}": ${cleaned}`);
  }

  // The prose OUTSIDE the tag is untouched too, front and back, including the
  // truncation ellipsis the storage path put there.
  assert.ok(cleaned.startsWith("Taking it: real section, not decoration."));
  assert.ok(cleaned.endsWith("hand-drawn curved arrows between consecutive ste…"));

  // THE JOIN IS REPAIRED, NOT MERELY EMPTIED. Deleting the tag and leaving its
  // spaces behind gives "bullets —  Environment" with two spaces, and dropping
  // both sides' spaces gives "db-scale-audit— each". Both are visible to the
  // owner, so both are asserted rather than assumed.
  assert.ok(cleaned.includes("build bullets — Environment first"), cleaned);
  assert.ok(cleaned.includes("db-scale-audit — each with a circled digit"), cleaned);
  assert.ok(!/ {2}/u.test(cleaned), `a doubled space was left where the tag was: ${cleaned}`);
});

/* -------------------------------------------------------------------------
 * 2. THE CONTROL THAT STOPS THE FIX BECOMING A NEW BUG
 * ---------------------------------------------------------------------- */

test("A RUN MESSAGE'S LEGITIMATE ANGLE BRACKETS SURVIVE — this is not a tag stripper", () => {
  /*
   * DELIBERATELY A `run` ROW'S TEXT, not an owner's. `db.ts` only sanitises `run`
   * rows, so an owner-text fixture here would pass with the rule replaced by
   * `replace(/<[^>]*>/g, "")` — the exact over-broad mutation this test exists to
   * catch — because that mutation lives inside the branch an owner row skips.
   */
  const said =
    "Changed the hero <div> to a <section> and pulled the copy into <MyComponent />. " +
    'Added <source src="hero.webp" type="image/webp"> inside the <picture>, and the ' +
    "helper is now generic<T extends string> with a guard that reads `if (a < b && c > d)`. " +
    "Also touched <p>, <span> and the <cite>-adjacent styling in globals.css.";

  const cleaned = stripAnnotationMarkup(said);

  for (const kept of [
    "<div>",
    "<section>",
    "<MyComponent />",
    /*
     * `<source>` IS THE ONE THAT COST A LIST ENTRY. It was in ANNOTATION_TAGS
     * until it was noticed that it is a real element — the child of `<picture>`,
     * `<video>` and `<audio>` — and that `design-prompt.ts` has runs producing a
     * `.webp` poster beside an `.mp4`, so a run narrating that markup is exactly
     * the message the over-broad list would have quietly eaten. It stays here so
     * putting it back turns this test red instead of shipping.
     */
    '<source src="hero.webp" type="image/webp">',
    "<picture>",
    "generic<T extends string>",
    "a < b && c > d",
    "<p>",
    "<span>",
  ]) {
    assert.ok(cleaned.includes(kept), `stripped legitimate content "${kept}": ${cleaned}`);
  }
});

/* -------------------------------------------------------------------------
 * 3. THE FORM THE STORAGE PATH ACTUALLY PRODUCES
 * ---------------------------------------------------------------------- */

test("A TAG CUT IN HALF BY THE 400-CHARACTER TRUNCATION IS STILL REMOVED", () => {
  /*
   * `plan-turn.ts:356` slices the seat's reply at MAX_REPLY_CHARS and appends "…".
   * The cut lands wherever it lands. The row on disk kept its `</cite>` by luck;
   * these two are the unlucky cuts, and a paired-only pattern renders both to the
   * owner verbatim — the second one COMPLETELY, since it has no `>` to match on.
   */
  const openOrphan = stripAnnotationMarkup(
    'The seven build bullets — <cite index="1-6,1-8">Environment first, Named specialists…',
  );
  assert.ok(!openOrphan.includes("<cite"), openOrphan);
  assert.ok(openOrphan.includes("bullets — Environment first, Named specialists…"), openOrphan);

  const midAttribute = stripAnnotationMarkup(
    'The seven build bullets — <cite index="1-6,1-8,1-11,1-…',
  );
  assert.ok(!midAttribute.includes("<cite"), midAttribute);
  assert.ok(!midAttribute.includes("index="), midAttribute);
  // THE TRAILING SPACE IS THE WHITESPACE RULE APPLIED WITHOUT AN EXCEPTION, and it
  // is asserted rather than trimmed away: a tag that ran to the end of the string
  // had a space in front of it, so a space is put back. Suppressing it would mean a
  // second branch in `stripAnnotationMarkup` to remove a character nothing renders.
  assert.equal(midAttribute, "The seven build bullets — ");

  // A closing tag with no opener — the other end of the same cut, when the head
  // of a long message is dropped rather than the tail.
  const closeOrphan = stripAnnotationMarkup("db-scale-audit</cite> — each with a digit");
  assert.equal(closeOrphan, "db-scale-audit — each with a digit");
});

/* -------------------------------------------------------------------------
 * 4. THE CLASS, NOT THE ONE TAG
 * ---------------------------------------------------------------------- */

test("THE WHOLE ANNOTATION SET IS HANDLED, AND THE CONTENT INSIDE EACH ONE IS KEPT", () => {
  for (const tag of ANNOTATION_TAGS) {
    const cleaned = stripAnnotationMarkup(`before <${tag}>the substance</${tag}> after`);
    assert.equal(cleaned, "before the substance after", `tag ${tag} was mishandled: ${cleaned}`);
  }

  // Case does not save a tag from removal.
  assert.equal(stripAnnotationMarkup("a <CITE>b</Cite> c"), "a b c");

  // The namespace, so a tag nobody listed by hand is still handled.
  assert.equal(
    stripAnnotationMarkup("<document_content>the brief</document_content>"),
    "the brief",
  );

  // A NAME THAT MERELY STARTS WITH A LISTED ONE IS NOT A LISTED ONE.
  assert.equal(stripAnnotationMarkup("a <citex>b</citex> c"), "a <citex>b</citex> c");

  // Running twice changes nothing — nothing downstream promises a single pass.
  const once = stripAnnotationMarkup(LEAKED);
  assert.equal(stripAnnotationMarkup(once), once);
});

/* -------------------------------------------------------------------------
 * 5. IT DOES NOT WEAKEN THE REDACTION IT SITS BEHIND
 * ---------------------------------------------------------------------- */

test("A REDACTED SPAN PASSES THROUGH UNTOUCHED — the two rules compose", () => {
  /*
   * `RunStore.appendMessage` runs `redactForPersistence` on the way in, and its
   * replacements are SQUARE-bracketed. If this module ever grew a rule that
   * reached them, a credential-shaped span would come back out of the store
   * looking like prose again. It cannot today, and this says so out loud.
   */
  const redacted = "the key is [REDACTED:ANTHROPIC_KEY_SHAPE:108] and the token is [REDACTED:JWT_SHAPE:212]";
  assert.equal(stripAnnotationMarkup(redacted), redacted);

  const fixture = store("redact");
  try {
    seed(fixture.store, "run-redact");
    fixture.store.appendMessage("run-redact", {
      role: "run",
      text: `key sk-ant-${"A".repeat(40)} inside <cite index="1-2">the quoted span</cite>`,
      images: [],
    });
    const [message] = fixture.store.messages("run-redact");
    assert.ok(message !== undefined);
    assert.ok(!message.text.includes("sk-ant-AAAA"), `the key survived: ${message.text}`);
    assert.ok(message.text.includes("[REDACTED:"), `the placeholder was eaten: ${message.text}`);
    assert.ok(!message.text.includes("<cite"), message.text);
    assert.ok(message.text.includes("the quoted span"), message.text);
  } finally {
    fixture.dispose();
  }
});

/* -------------------------------------------------------------------------
 * 6. THE WIRING — the store, not the function
 * ---------------------------------------------------------------------- */

test("THE STORE APPLIES IT ON READ AND KEEPS THE TRANSCRIPT VERBATIM ON DISK", () => {
  const fixture = store("wiring");
  try {
    seed(fixture.store, "run-wiring");
    fixture.store.appendMessage("run-wiring", { role: "run", text: LEAKED, images: [] });

    // What `GET /api/runs/:id/messages` serves — this is the owner's view.
    const [served] = fixture.store.messages("run-wiring");
    assert.ok(served !== undefined);
    assert.ok(!served.text.includes("<cite"), `the store served raw markup: ${served.text}`);
    for (const phrase of CITED_PROSE) {
      assert.ok(served.text.includes(phrase), `the store dropped "${phrase}"`);
    }

    /*
     * AND THE ROW ITSELF IS UNCHANGED. This is the property that justifies doing
     * the work on read instead of on write: the record of what the run said is
     * still on disk, and it would not be if the sanitiser had been put in
     * `appendMessage`. Read straight out of SQLite, past the mapper.
     */
    const raw = storedText(fixture.file, "run-wiring");
    assert.ok(raw.includes('<cite index="1-6'), `the stored transcript was rewritten: ${raw}`);
  } finally {
    fixture.dispose();
  }
});

test("AN OWNER'S OWN WORDS ARE NEVER TOUCHED — the prompt path stays byte-identical", () => {
  /*
   * NOT THE NEGATIVE CONTROL FOR OVER-STRIPPING — test 2 is, and it uses a `run`
   * row for the reason stated there. This one defends a different property:
   * `pendingMessages` reads through `messages()` and its rows are folded into the
   * next segment's prompt by `ownerMessageBlock`. An owner asking for a `<cite>`
   * tag must have the model see the characters he typed.
   */
  const typed = 'Wrap the pulled quote in <cite index="source">…</cite> and keep the <section> wrapper.';

  const fixture = store("owner");
  try {
    seed(fixture.store, "run-owner");
    fixture.store.appendMessage("run-owner", { role: "owner", text: typed, images: [] });

    const [served] = fixture.store.messages("run-owner");
    assert.ok(served !== undefined);
    assert.equal(served.text, typed);

    const [pending] = fixture.store.pendingMessages("run-owner");
    assert.ok(pending !== undefined);
    assert.equal(pending.text, typed);
  } finally {
    fixture.dispose();
  }
});
