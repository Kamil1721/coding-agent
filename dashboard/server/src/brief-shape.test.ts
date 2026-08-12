/**
 * brief-shape.test.ts — the intake check, against the briefs that produced it.
 *
 * TWO REAL BRIEFS ARE EMBEDDED VERBATIM, and they are the whole point of the
 * file. Run `dfd5a050` (2026-08-10) promised *"A reading of a reference page's
 * motion is attached to this ticket"* and its manifest carries `motion: null`;
 * run `fccefcee`, the run that actually produced a verdict, promised an attached
 * CV and an attached image and carried both. The rule must fire on the first and
 * be SILENT on the second, with the same attachment counts. A rule tested only
 * against the brief it was written for is a rule that fires on everything.
 *
 * The briefs are JSON string literals rather than template literals because both
 * contain backticks.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { briefShape } from "./brief-shape.js";
import type { BriefAttachments } from "./brief-shape.js";

/** What both runs actually carried: one image, one document, no motion, no capture. */
const AS_FILED: BriefAttachments = Object.freeze({
  images: 1,
  documents: 1,
  motion: false,
  capture: false,
});

const NOTHING: BriefAttachments = Object.freeze({
  images: 0,
  documents: 0,
  motion: false,
  capture: false,
});

/** Run `dfd5a050`'s brief, verbatim. Manifest motion was null. */
const BRIEF_DANGLING_MOTION = "Build my personal portfolio site \u2014 a real application with a working backend, not a\nstatic page with a decorative contact form.\n\nContent comes from the attached CV. Take the roles, dates, projects, skills and\ncontact details from it. Do not invent employers, job titles, dates or numbers. If\nthe CV is ambiguous about something, leave it out rather than filling the gap.\n\nTHE LOOK\n\nHand-drawn sketchbook, not a template. The attached image is the direction. In words,\nso it can be graded:\n\nWarm off-white paper background with faint coloured-pencil scribble at the edges of\nthe viewport. Content sits on slightly tilted white paper cards with soft drop shadows\nand thin dark hand-inked rules, as if photographed on a desk. Headings are large,\nuppercase, condensed and hand-lettered in near-black. Body copy is a plain readable\nserif at normal weight \u2014 the drawing carries the personality, the text does not need\nto. Illustrations are coloured-pencil line art with visible hatching, in a restrained\npalette of purple, orange, green, red and blue on paper white. Buttons are small\noutlined pills with lowercase labels. Section flows are numbered with circled digits\nand hand-drawn curved arrows between steps. Top navigation is a single row of\nuppercase links with a hand-drawn underline under the active one.\n\nNo gradients, no glassmorphism, no neon, no dark mode. If it could have come out of a\ngeneric component library, it is wrong.\n\nTHE MOTION\n\nA reading of a reference page's motion is attached to this ticket. Match it: same\nfamilies, same properties, durations and stagger within about 40% of the numbers\ngiven. Where the reading says a family was observed but not compared, treat it as a\ndirection rather than a measurement. Everything must still work with\nprefers-reduced-motion: reduce \u2014 motion is the finish, never the mechanism.\n\nRESEARCH BEFORE YOU BUILD\n\nYou have network access while building; the graders do not. Before writing the\nillustration and motion layer, look up how hand-drawn and sketch aesthetics are\nactually implemented on the web today, and how the motion families in the attached\nreading are usually built. Say in your self-report what you looked at and what you\ntook from it. Vendor anything you depend on into the artefact \u2014 nothing is fetched at\ngrading time.\n\nPAGES\n\n/          hero with my name, role and one line about what I do; a short selected-work\n           strip pulled from the CV.\n/work      projects from the CV, each as its own paper card: title, what it is, the\n           stack, my role.\n/about     the career narrative, roles and dates from the CV, and the skills list.\n/contact   the form described below.\n\nTHE BACKEND \u2014 THIS IS THE PART THAT MUST ACTUALLY WORK\n\nA Node HTTP server. Zero runtime npm dependencies: node:http, node:sqlite and the\nstandard library only. Starts with `npm start`, listens on PORT defaulting to 3000,\nserves every page and API route from one process, and persists to a SQLite file\ncreated automatically on first boot.\n\n  POST /api/contact   accepts {name, email, message} as JSON. Validates all three:\n                      name non-empty, email structurally valid, message at least 20\n                      characters. Rejects with 400 and a JSON body naming WHICH field\n                      failed. On success stores the message with a timestamp and\n                      returns 201 with the new record's id. An empty or invalid\n                      submission must never be stored and must never return a success\n                      response \u2014 a form that confirms a submission it discarded is the\n                      failure I care most about.\n  GET  /api/messages  stored messages as JSON, newest first. Requires a bearer token\n                      read from an environment variable at boot: 401 without it, 401\n                      with the wrong one. If the variable is unset the route stays\n                      available and refuses every request rather than opening up.\n  GET  /api/projects  the CV's projects as JSON, served from the database rather than\n                      hardcoded in the page, seeded on first boot.\n  GET  /api/health    200 with {\"ok\":true}.\n  everything else     a real 404 page in the site's own visual style \u2014 not a stack\n                      trace, not a blank body.\n\nThe contact page posts to /api/contact for real and renders the server's response: the\nfield-level error on a 400, a confirmation on a 201. No optimistic \"thanks!\" before the\nserver has answered. Rate-limit POST /api/contact to a handful of submissions per\nminute per IP, in memory, returning 429 past that.\n\nYOU CANNOT OPEN A PORT WHILE BUILDING THIS\n\nThe build sandbox denies listen() on every port with EPERM. That is measured. So\nstructure it to be testable without a socket: request handling in an exported router\nfunction, `server.mjs` doing nothing but wiring it to node:http, every database access\nbehind functions taking a database handle as an argument. Write node --test tests that\ncall those directly. Cover the 400 on each invalid field, the 201, both 401s, the 429,\nand survival of data across a reopen. Run them and get them passing before you declare\ndone, and say how many there are.\n\nCONSTRAINTS\n\nRuns entirely offline once built. No external API, no hosted database, no email\nprovider, no analytics, no third-party fonts or CDN \u2014 embed or self-host every asset.\nNo secrets in the repository; the one token is read from the environment. Responsive at\n1440, 768 and 375 with no horizontal scrolling. Keyboard-navigable throughout, visible\nfocus rings, alt text on every illustration.\n\nHOW I WILL KNOW IT WORKS\n\n- `npm start` boots on one port and serves every page and every API route.\n- Submitting the contact form with a blank message shows a field error and stores\n  nothing; GET /api/messages with the right token proves the count did not change.\n- A valid message returns 201 and then appears in GET /api/messages.\n- GET /api/messages with no token and with a wrong token both return 401.\n- Killing the server and starting it again still returns messages submitted before.\n- Every project on /work traces to a line in the attached CV.\n- All four pages render in the sketchbook style at 1440, 768 and 375.\n- The motion matches the attached reading, and the site is fully usable with reduced\n  motion enabled.\n\n--- WHAT IS DIFFERENT THIS TIME ---\n\nYou built this once already. It came out close, and these are the things I want changed.\nEverything above still stands; the list below is in addition to it, not instead of it.\n\nEACH PROJECT GETS ITS OWN PAGE\n\nOn /work the six project cards currently go nowhere. Clicking a project must open a page\nabout that project, the way it works on kamilborzecki.dev.\n\n- Route: /work/<slug>, one per project, where the slug comes from the project name \u2014\n  /work/teewise, /work/trade-assistant, /work/jobsilver, /work/kori, /work/parts-agent,\n  /work/crewflow. Typing one of those URLs directly must work, not just clicking through.\n- The whole card is the link, and it looks like one: it responds to hover and to keyboard\n  focus, and it is reachable by Tab in the order the cards appear.\n- Each project page carries, all of it from the CV and none of it invented: the project\n  name as the page heading, what it is, my role, the stack, and a fuller description than\n  the card gives \u2014 several sentences, not a repeat of the one-liner. The project's\n  illustration appears at a larger size than on the card.\n- A clear way back to /work.\n- An unknown slug \u2014 /work/nonsense \u2014 gets the real 404 page in the site's own style, not a\n  crash and not a blank body.\n- The six project pages are part of the site's navigation, so the nav row stays pinned on\n  them too and the sketchbook style is identical.\n\nDO NOT STOP AT THE LITERAL MINIMUM\n\nLast time the site did exactly what the sentence said and nothing around it. Where a page\nobviously wants one more thing to feel finished \u2014 the next and previous project at the foot\nof a project page, the work page linking into the projects it lists, a heading that says\nwhere you are \u2014 build it. Judge it by whether a person reading the page would notice its\nabsence. This is a portfolio; it is supposed to feel made, not generated.\n\nTWO THINGS THAT WERE VISIBLY WRONG\n\n- Every illustration rendered STRETCHED. The images carry width and height attributes and\n  sit in narrower columns, and the stylesheet never let the height follow the width. Every\n  image on every page must render at its true proportions at 1440, 768 and 375. Nothing\n  squashed, nothing letterboxed, no distorted faces or circles.\n- At least one thing that is supposed to move does not. Whatever motion you declare, make\n  sure it actually runs in a normal browser \u2014 and that all of it still stops when\n  prefers-reduced-motion is set.\n\nHOW I WILL KNOW THIS PART WORKS\n\n- Clicking any of the six cards on /work lands on that project's page.\n- Each of the six URLs above loads directly, with that project's own content.\n- /work/nonsense returns the styled 404.\n- No image anywhere renders at a different shape from the file it came from.\n- Every project page is keyboard reachable and readable at 375 with no horizontal scroll.\n";

/** Run `fccefcee`'s brief, verbatim. Every attachment it names was attached. */
const BRIEF_CLEAN = "Build my personal portfolio site \u2014 a real application with a working backend, not a\nstatic page with a decorative contact form.\n\nContent comes from the attached CV. Take the roles, dates, projects, skills and\ncontact details from it. Do not invent employers, job titles, dates or numbers. If\nthe CV is ambiguous about something, leave it out rather than filling the gap.\n\nTHE LOOK\n\nHand-drawn sketchbook, not a template. The attached image is the direction. In words,\nso it can be graded:\n\nWarm off-white paper background with faint coloured-pencil scribble at the edges of\nthe viewport. Content sits on slightly tilted white paper cards with soft drop shadows\nand thin dark hand-inked rules, as if photographed on a desk. Headings are large,\nuppercase, condensed and hand-lettered in near-black. Body copy is a plain readable\nserif at normal weight \u2014 the drawing carries the personality, the text does not need\nto. Illustrations are coloured-pencil line art with visible hatching, in a restrained\npalette of purple, orange, green, red and blue on paper white. Buttons are small\noutlined pills with lowercase labels. Section flows are numbered with circled digits\nand hand-drawn curved arrows between steps. Top navigation is a single row of\nuppercase links with a hand-drawn underline under the active one.\n\nNo gradients, no glassmorphism, no neon, no dark mode. If it could have come out of a\ngeneric component library, it is wrong.\n\nTHE MOTION\n\nKeep it to what the reference page actually does, which is very little: text spans\nreveal once as they scroll into view, animating transform over about 250ms. Nothing\nelse moves on its own. Stay within about 40% of that duration, animate transform\nrather than layout, and reveal each element once rather than every time it re-enters\nthe viewport. Everything must still work with\nprefers-reduced-motion: reduce \u2014 motion is the finish, never the mechanism.\n\nRESEARCH BEFORE YOU BUILD\n\nYou have network access while building; the graders do not. Before writing the\nillustration and motion layer, look up how hand-drawn and sketch aesthetics are\nactually implemented on the web today, and how the motion described above is\nusually built. Say in your self-report what you looked at and what you\ntook from it. Vendor anything you depend on into the artefact \u2014 nothing is fetched at\ngrading time.\n\nPAGES\n\n/          hero with my name, role and one line about what I do; a short selected-work\n           strip pulled from the CV.\n/work      projects from the CV, each as its own paper card: title, what it is, the\n           stack, my role.\n/about     the career narrative, roles and dates from the CV, and the skills list.\n/contact   the form described below.\n\nTHE BACKEND \u2014 THIS IS THE PART THAT MUST ACTUALLY WORK\n\nA Node HTTP server. Zero runtime npm dependencies: node:http, node:sqlite and the\nstandard library only. Starts with `npm start`, listens on PORT defaulting to 3000,\nserves every page and API route from one process, and persists to a SQLite file\ncreated automatically on first boot.\n\n  POST /api/contact   accepts {name, email, message} as JSON. Validates all three:\n                      name non-empty, email structurally valid, message at least 20\n                      characters. Rejects with 400 and a JSON body naming WHICH field\n                      failed. On success stores the message with a timestamp and\n                      returns 201 with the new record's id. An empty or invalid\n                      submission must never be stored and must never return a success\n                      response \u2014 a form that confirms a submission it discarded is the\n                      failure I care most about.\n  GET  /api/messages  stored messages as JSON, newest first. Requires a bearer token\n                      read from an environment variable at boot: 401 without it, 401\n                      with the wrong one. If the variable is unset the route stays\n                      available and refuses every request rather than opening up.\n  GET  /api/projects  the CV's projects as JSON, served from the database rather than\n                      hardcoded in the page, seeded on first boot.\n  GET  /api/health    200 with {\"ok\":true}.\n  everything else     a real 404 page in the site's own visual style \u2014 not a stack\n                      trace, not a blank body.\n\nThe contact page posts to /api/contact for real and renders the server's response: the\nfield-level error on a 400, a confirmation on a 201. No optimistic \"thanks!\" before the\nserver has answered. Rate-limit POST /api/contact to a handful of submissions per\nminute per IP, in memory, returning 429 past that.\n\nYOU CANNOT OPEN A PORT WHILE BUILDING THIS\n\nThe build sandbox denies listen() on every port with EPERM. That is measured. So\nstructure it to be testable without a socket: request handling in an exported router\nfunction, `server.mjs` doing nothing but wiring it to node:http, every database access\nbehind functions taking a database handle as an argument. Write node --test tests that\ncall those directly. Cover the 400 on each invalid field, the 201, both 401s, the 429,\nand survival of data across a reopen. Run them and get them passing before you declare\ndone, and say how many there are.\n\nCONSTRAINTS\n\nRuns entirely offline once built. No external API, no hosted database, no email\nprovider, no analytics, no third-party fonts or CDN \u2014 embed or self-host every asset.\nNo secrets in the repository; the one token is read from the environment. Responsive at\n1440, 768 and 375 with no horizontal scrolling. Keyboard-navigable throughout, visible\nfocus rings, alt text on every illustration.\n\nHOW I WILL KNOW IT WORKS\n\n- `npm start` boots on one port and serves every page and every API route.\n- Submitting the contact form with a blank message shows a field error and stores\n  nothing; GET /api/messages with the right token proves the count did not change.\n- A valid message returns 201 and then appears in GET /api/messages.\n- GET /api/messages with no token and with a wrong token both return 401.\n- Killing the server and starting it again still returns messages submitted before.\n- Every project on /work traces to a line in the attached CV.\n- All four pages render in the sketchbook style at 1440, 768 and 375.\n- The motion matches what is described above, and the site is fully usable with reduced\n  motion enabled.\n\n--- WHAT IS DIFFERENT THIS TIME ---\n\nYou built this once already. It came out close. Everything above still stands; the list\nbelow is in addition to it.\n\nEACH PROJECT GETS ITS OWN PAGE\n\nOn /work the six project cards go nowhere. Clicking a project must open a page about that\nproject, the way it works on kamilborzecki.dev.\n\nTreat the six project pages as ONE requirement, not six. They share a single template, and\none test that walks all six slugs is the right way to check them.\n\nStated one requirement at a time:\n\n- When a visitor clicks a project card on /work, the site shall open that project's page.\n- The site shall serve a page at /work/<slug> for each of the six projects, where slug is\n  teewise, trade-assistant, jobsilver, kori, parts-agent and crewflow. Typing the URL\n  directly shall work, not only clicking through.\n- The site shall render, on each project page, the project name as the page heading.\n- The site shall render, on each project page, a description of several sentences taken from\n  the CV that does not appear on /work.\n- The site shall render, on each project page, that project's role and stack from the CV.\n- The site shall render, on each project page, that project's illustration.\n- The site shall render, on each project page, a link back to /work.\n- Where a project page is shown, the site shall keep the top navigation pinned and the\n  sketchbook style identical to the rest of the site.\n- If a project slug does not exist, then the site shall serve the styled 404 page rather than\n  a crash or a blank body.\n- The site shall make every project card reachable by keyboard, in the order the cards\n  appear, with a visible focus ring.\n\nGO ONE STEP PAST THE LITERAL MINIMUM\n\nThe site shall render, at the foot of each project page, links to the previous and next\nproject.\n\nTWO THINGS THAT WERE VISIBLY WRONG\n\n- Every illustration rendered STRETCHED. The images carry width and height attributes and sit\n  in narrower columns, and the stylesheet never let the height follow the width. The site\n  shall render every image at its true proportions at 1440, 768 and 375 \u2014 nothing squashed,\n  nothing letterboxed.\n- At least one thing that is supposed to move does not. The site shall actually run whatever\n  motion it declares, and shall stop all of it when prefers-reduced-motion is set.\n\nHOW I WILL KNOW THIS PART WORKS\n\n- Clicking any of the six cards on /work lands on that project's page.\n- Each of the six URLs loads directly, with that project's own content.\n- /work/nonsense returns the styled 404.\n- No image renders at a different shape from the file it came from.\n- Every project page is readable at 375 with no horizontal scrolling.\n";

const blocking = (brief: string, attachments: BriefAttachments) =>
  briefShape(brief, attachments).filter((f) => f.blocking);

/* -------------------------------------------------------------------------
 * The pair
 * ---------------------------------------------------------------------- */

test("dfd5a050's brief promised a motion reading it did not carry, and is refused", () => {
  const found = blocking(BRIEF_DANGLING_MOTION, AS_FILED);
  assert.ok(found.length > 0, "the brief that cost a run passes the check unrefused");
  assert.ok(found.every((f) => f.code === "dangling_attachment"));
  assert.ok(
    found.some((f) => /reading of a reference page's motion is attached/.test(f.sentence)),
    `the sentence that made the promise is not among the findings: ${JSON.stringify(found.map((f) => f.sentence))}`,
  );
});

test("NEGATIVE CONTROL: fccefcee's brief names two attachments, carries both, and is silent", () => {
  assert.deepEqual(
    blocking(BRIEF_CLEAN, AS_FILED),
    [],
    "the brief of the run that produced a verdict would have been refused at intake",
  );
});

test("the same clean brief IS refused when the things it names are absent", () => {
  // THE ARM THAT PROVES THE RULE READS THE MANIFEST. If the previous test passed
  // because the rule never fires on this brief — rather than because its
  // attachments were present — this one would pass too, and it must not.
  const found = blocking(BRIEF_CLEAN, NOTHING);
  assert.ok(found.length > 0, "with nothing attached, 'the attached CV' is a dangling promise");
  assert.ok(found.some((f) => /attached CV/i.test(f.sentence)));
});

test("the motion promise is the ONLY thing separating the two briefs", () => {
  // Both were filed with one image and one document. The difference in verdict
  // must therefore be the motion sentences and nothing else.
  const danglingSlots = new Set(blocking(BRIEF_DANGLING_MOTION, AS_FILED).map((f) => f.detail));
  assert.ok(
    [...danglingSlots].every((d) => /motion/i.test(d)),
    `a slot other than motion was refused: ${JSON.stringify([...danglingSlots])}`,
  );
});

/* -------------------------------------------------------------------------
 * The blocking rule, in isolation
 * ---------------------------------------------------------------------- */

test("a filled slot silences the claim, an empty one does not", () => {
  const brief = "Build the page. The attached screenshot is the direction.";
  assert.equal(blocking(brief, { ...NOTHING, images: 1 }).length, 0);
  assert.equal(blocking(brief, NOTHING).length, 1);
});

test("an INSTRUCTION to attach is not a CLAIM that something is attached", () => {
  // "attach the CV" is about the future and refusing it would refuse a brief
  // that is telling the truth.
  assert.deepEqual(blocking("Please attach the CV before running this.", NOTHING), []);
});

test("a denial that nothing is attached is not a promise", () => {
  for (const brief of [
    "No attachments here.",
    "There is no attached document for this ticket.",
    "Build it without the attached image.",
  ]) {
    assert.deepEqual(blocking(brief, NOTHING), [], `refused a brief that agrees with its manifest: ${brief}`);
  }
});

test("a kind that merely co-occurs with 'attached' does not name the attached thing", () => {
  // The adjacency requirement. "design" is an ordinary English word and this is
  // the sentence that would make it dangerous.
  assert.deepEqual(
    blocking("The attached CV describes the design of the system.", { ...NOTHING, documents: 1 }),
    [],
    "an image was demanded because the word 'design' appeared somewhere after 'attached'",
  );
});

test("the trailing-copula shape is caught, not only 'the attached X'", () => {
  const found = blocking("A recording of the interaction is attached to this ticket.", NOTHING);
  assert.equal(found.length, 1);
  assert.match(found[0]?.detail ?? "", /motion/i);
});

/* -------------------------------------------------------------------------
 * The advisories — which must never refuse anything
 * ---------------------------------------------------------------------- */

test("no advisory is ever blocking", () => {
  const all = briefShape(BRIEF_CLEAN, AS_FILED);
  assert.ok(all.length > 0, "the fixture produces no advisory at all, so this proves nothing");
  for (const finding of all) {
    if (finding.code === "dangling_attachment") continue;
    assert.equal(finding.blocking, false, `${finding.code} was blocking`);
  }
});

test("multi_obligation ignores ordinary prose lists and fires on acceptance bullets", () => {
  const prose = "Take the roles, dates, projects, skills and contact details from it.";
  assert.deepEqual(
    briefShape(prose, AS_FILED).filter((f) => f.code === "multi_obligation"),
    [],
    "a five-item noun list in ordinary prose was read as five obligations",
  );

  const bullet =
    "HOW I WILL KNOW IT WORKS\n\n- Submitting the form shows a field error and stores nothing; " +
    "GET /api/messages proves the count did not change.";
  assert.equal(
    briefShape(bullet, AS_FILED).filter((f) => f.code === "multi_obligation").length,
    1,
    "a three-obligation acceptance bullet was not flagged",
  );
});

test("a two-obligation requirement stays silent — the counter counts, it does not just fire", () => {
  const two =
    "The site shall actually run whatever motion it declares, and shall stop all of it when " +
    "prefers-reduced-motion is set.";
  assert.deepEqual(
    briefShape(two, AS_FILED).filter((f) => f.code === "multi_obligation"),
    [],
  );
});

test("weak modals and scale language are reported, on requirement-bearing sentences", () => {
  const weak = briefShape("The site shall be fast and should ideally load quickly.", AS_FILED);
  assert.ok(weak.some((f) => f.code === "weak_modal"));

  const scale = briefShape("Rate the design on a scale of 1 to 5.", AS_FILED);
  assert.ok(scale.some((f) => f.code === "scale_language"));
});

/* -------------------------------------------------------------------------
 * A brief that AGREES with its manifest must never be refused
 * ---------------------------------------------------------------------- */

/**
 * FOUND BY PROBE, 2026-08-12. The negation guard read only the text BEFORE the
 * attachment word, so a denial that followed it — "Attached: none." — was read
 * as a promise and answered with a 400. This rule refuses the owner's work at
 * the submit button; a false refusal there is the one error it may not make.
 */
test("a denial AFTER the attachment word is not a promise either", () => {
  for (const brief of ["Attached: none.", "Attachments: none", "Attachment: n/a"]) {
    assert.deepEqual(blocking(brief, NOTHING), [], `refused a brief that says nothing is attached: ${brief}`);
  }
});

test("dismissing an attachment is not claiming one", () => {
  assert.deepEqual(blocking("Ignore any attachment you find.", NOTHING), []);
  assert.deepEqual(blocking("Disregard the attachment from last time.", NOTHING), []);
});

test("THE OTHER ARM: a 'not' after the word must still leave a real promise standing", () => {
  // The denial rule is deliberately narrower than its twin. If it ever grows to
  // match `not`, this promise goes silent and the check stops working.
  const found = blocking("The attached CV is not optional.", NOTHING);
  assert.equal(found.length, 1, "a real promise was silenced by the denial guard");
});

/* -------------------------------------------------------------------------
 * The quoted sentence must be findable in the owner's own textarea
 * ---------------------------------------------------------------------- */

/**
 * THE MODULE'S DOCBLOCK CLAIMED THIS FILE ASSERTED THIS, AND IT DID NOT.
 * The claim was true and untested, which is the worse of the two failures: the
 * property could have stopped holding — a `trim()` moved, a sentence rebuilt
 * from parts — and nothing would have said so. A 400 quotes the sentence back,
 * and a quote the owner cannot find by searching his own brief is worse than no
 * quote at all.
 */
test("every finding quotes a sentence that appears verbatim in the brief", () => {
  for (const [name, brief] of [
    ["dangling", BRIEF_DANGLING_MOTION],
    ["clean", BRIEF_CLEAN],
  ] as const) {
    const findings = briefShape(brief, NOTHING);
    assert.ok(findings.length > 0, `${name} produced no findings, so this proves nothing`);
    for (const finding of findings) {
      assert.ok(
        brief.includes(finding.sentence),
        `${name}: a ${finding.code} finding quoted a sentence that is not in the brief: ` +
          JSON.stringify(finding.sentence),
      );
    }
  }
});

/* -------------------------------------------------------------------------
 * PROSE ABOUT ATTACHMENTS IS NOT A CLAIM ABOUT THIS REQUEST
 * ---------------------------------------------------------------------- */

/**
 * FOUND BY ADVERSARIAL REVIEW, 2026-08-12, AND IT WAS SHIPPED. The
 * `attachedThenKind` arm matched any prose containing an attachment word near a
 * kind word, so a brief for software that HANDLES uploads was refused at the
 * submit button. Every sentence below was answered 400 with three images, two
 * documents and a page capture attached.
 *
 * The distinguisher is deixis: a claim points at one thing ("the attached CV"),
 * a feature description quantifies a class ("each attached video").
 */
const PRODUCT_PROSE: readonly string[] = Object.freeze([
  "Each attached video shall be transcoded to MP4 on upload.",
  "The player shows attached recordings inline.",
  "Deleting an attachment removes the recording from storage.",
  "The gallery lists attached videos newest first.",
  "The panel shall list attached documents in a table.",
  "Each attached document shall be virus-scanned before it is stored.",
  "Hovering an attachment shows the document name and size.",
  "Users may download any attachment as a PDF.",
  "An attachment larger than 10 MB is rejected with a clear message.",
]);

test("a ticket for software that handles attachments is not refused", () => {
  const rich: BriefAttachments = { images: 3, documents: 2, motion: false, capture: true };
  const sparse: BriefAttachments = { images: 1, documents: 0, motion: false, capture: false };
  for (const sentence of PRODUCT_PROSE) {
    for (const attachments of [rich, sparse, NOTHING]) {
      assert.deepEqual(
        blocking(sentence, attachments),
        [],
        `refused a sentence describing the product, not this request: ${sentence}`,
      );
    }
  }
});

test("THE OTHER ARM: a deictic claim still fires, or the rule now catches nothing", () => {
  // Without this, the fix above could be "delete the rule" and the file stays
  // green. Each of these points at ONE thing that is not here.
  for (const sentence of [
    "Content comes from the attached CV.",
    "The attached image is the direction.",
    "A reading of a reference page's motion is attached to this ticket.",
    "I have attached the screenshot.",
    "Build it to match this attached mockup.",
  ]) {
    assert.equal(
      blocking(sentence, NOTHING).length,
      1,
      `a real dangling promise stopped being caught: ${sentence}`,
    );
  }
});
