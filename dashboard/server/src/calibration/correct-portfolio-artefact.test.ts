/**
 * calibration/correct-portfolio-artefact.test.ts — a REGRESSION GUARD on the
 * re-implemented false-fail control. NOT a second opinion on the grader.
 *
 * WHY IT EXISTS. `correct-portfolio` is the fixture `fixtures.ts` designates THE
 * FALSE-FAIL CONTROL, and on 2026-07-29 the owner had it re-implemented: the
 * contact form gained a place to type a message alongside the email field, and
 * the hero, the three project entries and the contact section gained the copy a
 * portfolio of that ticket would carry.
 *
 * MEASURED, AND IT IS THE REASON THIS FILE EXISTS: the standing 4A run cannot
 * see any of that. All seven fixtures grade to byte-identical outcome / tier /
 * failed-gate / failed-criterion / QUALITY rows before and after
 * (probes/results/calibration-4a.before-refix.json vs `.after-refix.json`).
 * `suites/portfolio-suite.ts` asserts an email field, a submit control and a
 * confirmation, and nothing about a message. So the only thing that would tell
 * anyone the re-implementation had been quietly reverted is this file.
 *
 * AND THE SUITE MUST NOT BE CHANGED TO SEE IT. One criteria set grades all seven
 * artefacts — that is what stops the ruler being tuned to the thing measured —
 * and `stock-motion-only`, which must PASS, ships the same email-and-button
 * form. A message-field criterion in the frozen suite would false-fail it, which
 * is the failure this whole tree exists to prevent.
 *
 * WHY THERE IS NO COPY-LENGTH ASSERTION IN HERE. Calibration 4B's
 * model-authored suite failed this same artefact on a 200-character body-text
 * floor, and the recorded conclusion was that the BAR was the defect: nothing in
 * "a hero with her name, a projects section listing at least three projects, and
 * a contact form that confirms when submitted" implies a character count.
 * Writing one here would re-import that mistake with the dashboard's own name on
 * it. THE CONSEQUENCE, stated plainly rather than left to be discovered: a
 * regression of the copy back to one clause per project is caught by NOTHING —
 * not by this file, and not by the seven-fixture calibration run.
 *
 * IT FAILS ALONE, MEASURED RATHER THAN ASSUMED. Deleting the `<textarea>` turns
 * this file RED (1 of 1) while `correct-portfolio` still grades `pass/null`
 * through the real sealed container in the same session. A check whose failure
 * mode is a strict subset of a louder check's is not a second check, and this
 * repo has shipped that shape eleven times.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. That the email input, the submit control
 * or the confirmation are present: held-out test T-4 already fails the fixture
 * when any of them goes, so an assertion here would be a quieter copy of a
 * louder check. That the message control is not `required`: same reason, and it
 * is measured — marking it `required` was run through the container on
 * 2026-07-29 and turned `correct-portfolio` into `fail/FUNCTIONAL` on REQ-004,
 * because Chromium's interactive validation fires before the `submit` event, so
 * `preventDefault` never runs and the confirmation never unhides.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { artefactDir } from "./fixtures.js";

/** The contact form's markup, or a failure that names what was not found. */
function contactFormMarkup(): string {
  const html = readFileSync(join(artefactDir("correct-portfolio"), "index.html"), "utf8");
  const form = /<form\b[^>]*\bid=["']contact-form["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (form === null || form[1] === undefined) {
    throw new Error(
      "correct-portfolio/index.html has no <form id=\"contact-form\"> — the artefact was restructured, so " +
        "this guard cannot say anything about the field it was written to watch",
    );
  }
  return form[1];
}

test("the re-implemented contact form still ships a message control alongside the email field", () => {
  const markup = contactFormMarkup();
  // A <textarea>, or an input named/ided for the message: the ticket asks for
  // "a contact form", and a reader of "a contact form that confirms when
  // submitted" would expect somewhere to type the message. Which element type
  // carries it is the artefact's choice; that one exists inside the SAME form as
  // the email field is what makes the artefact answer the ticket.
  const hasMessageControl =
    /<textarea\b/i.test(markup) || /<input\b[^>]*\b(?:name|id)=["']message["']/i.test(markup);
  assert.ok(
    hasMessageControl,
    "the contact form has an email field and a submit control and nowhere to type a message. That is the " +
      "shape calibration 4B judged a FIXTURE defect rather than a grader defect, and re-implementing it is " +
      "why this artefact was rewritten on 2026-07-29. Nothing in the frozen 4A suite observes this, so the " +
      "seven-fixture run stays green while the false-fail control goes back to being thin.\n" +
      `form markup was: ${markup.trim()}`,
  );
});
