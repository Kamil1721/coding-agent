/**
 * ticket.test.ts — what counts as a brief.
 *
 * Written 2026-08-03 from a debugfix finding, not from a design review: the
 * adversary armed this app's most expensive action from a textarea the owner
 * could see was empty.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { briefHasContent } from "./ticket.js";

test("a brief of INVISIBLE characters is empty, whatever `trim()` says", () => {
  // DEMONSTRATED against the running dashboard on 2026-08-03 by the debugfix
  // adversary: eight U+200B in the ticket textarea rendered a visibly EMPTY
  // field, the counter read "8 chars", the "Write the brief first." hint
  // disappeared and Start run went enabled. `POST /api/runs` agreed — its own
  // check was `ticketText.trim().length === 0`.
  //
  // The cost is not a wasted click. The acceptance suite is authored from the
  // brief and frozen by digest before any code exists, so a brief of nothing
  // freezes a suite of guesses and bills hours to satisfy it.
  const zeroWidth = "​".repeat(8);
  assert.equal(zeroWidth.trim().length, 8, "the premise: trim() keeps these");
  assert.equal(briefHasContent(zeroWidth), false, "eight zero-width spaces are not a brief");

  // The whole format category, not the four that were demonstrated —
  // enumerating them is how the next one gets in.
  for (const [name, ch] of [
    ["soft hyphen", "­"],
    ["word joiner", "⁠"],
    ["right-to-left override", "‮"],
    ["zero-width non-joiner", "‌"],
  ] as const) {
    assert.equal(briefHasContent(ch.repeat(4)), false, `${name} alone is not a brief`);
    assert.equal(briefHasContent(`build me a site${ch}`), true, `${name} must not erase a real brief`);
  }

  // NEGATIVE CONTROLS. Whitespace was already handled and must stay handled;
  // real briefs must never be refused, including ones in scripts where
  // combining marks carry meaning — those are NOT format characters and are
  // deliberately not stripped.
  assert.equal(briefHasContent(""), false);
  assert.equal(briefHasContent("   \n\t  "), false);
  assert.equal(briefHasContent(" "), false, "NBSP is whitespace, trim already took it");
  assert.equal(briefHasContent("a"), true);
  assert.equal(briefHasContent("zrób mi stronę"), true);
  assert.equal(briefHasContent("ให้ทำเว็บไซต์"), true, "combining marks are content, not format");
});
