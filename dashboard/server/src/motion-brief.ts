/**
 * motion-brief.ts — the only words about motion the spec seat ever reads.
 *
 * THE SPEC SEAT IS TEXT ONLY. `bakeoff/src/spec-agent.ts` sends the ticket id
 * and the brief between markers and nothing else — no file, no image, no path.
 * So a motion fact that is not in these lines does not exist as far as the
 * acceptance suite is concerned.
 *
 * EVERY LINE HERE ENTERS `ticket.sha256`. That is why this module is pure, why
 * it renders in a fixed order, and why it prints nothing at all for an empty
 * spec rather than a heading above an empty list — `outlineLines` sets that
 * precedent for exactly the same reason.
 *
 * THE PARITY/PRESENCE SPLIT IS SAID OUT LOUD. Two families can only be observed
 * to exist, never compared, and a brief that read the same for both would invite
 * the spec seat to author a criterion nothing can check.
 *
 * THE ROLE IS RE-CHECKED HERE EVEN THOUGH THE CAPTURE IS SUPPOSED TO PRODUCE A
 * SAFE ONE. `ticket-refs.ts:24-30` forbids a path, a filename or a sentence
 * naming an attachment from ever entering the brief, and this file is the last
 * place a role passes through before it is composed in. `safeRole` below is that
 * check; it is a shape test, not knowledge of what the element was.
 */
import type { MotionEntry, MotionFamily, MotionSpec } from "./motion-types.js";
// A TYPE-ONLY IMPORT, AND IT HAS TO STAY ONE. This module's header claims it is
// pure and that every line it emits is hashed into the ticket id; importing the
// tracer's runtime would put a second module on that path for no gain. Nothing
// in `spec-assumptions.ts` imports this file back, so there is no cycle either
// way — but the erasure is what makes that a guarantee rather than a habit.
import type { ReferenceObservation, ReferenceReading } from "./spec-assumptions.js";

export const MOTION_BLOCK_BEGIN = "--- MOTION READ FROM THE REFERENCE PAGE (BEGIN) ---";
export const MOTION_BLOCK_END = "--- MOTION READ FROM THE REFERENCE PAGE (END) ---";

/**
 * Every family, keyed by the union rather than by `string`, so a thirteenth
 * family is a compile error here. Keyed by `string` it would fall back to
 * printing the raw slug — `route-transition` — into a brief that is hashed into
 * the ticket id, which is a silent wrong answer where a build failure is
 * available. `spec-assumptions.ts` takes the same position about its own union.
 */
const FAMILY_PROSE: Record<MotionFamily, string> = {
  "load-entrance": "on load, entering",
  "scroll-reveal": "revealed once on scroll into view",
  "scroll-linked": "driven by scroll position rather than by time",
  "hover-focus": "on hover and on keyboard focus",
  "ambient-loop": "looping continuously with no trigger",
  "split-text": "per-character, staggered",
  "path-draw": "an SVG stroke drawing itself",
  "scroll-inertia": "smooth-scroll inertia on the document",
  "cursor-follow": "following the pointer",
  "tilt-3d": "tilting in 3D toward the pointer",
  "route-transition": "between routes",
  "canvas-ambient": "a canvas or WebGL surface repainting continuously",
};

/** What an element is called when its role does not survive `safeRole`. */
const UNNAMED_ROLE = "an element";

/** `div`, `h1`, `div.card`, `section#hero`, `my-widget.card` — and nothing else. */
const ROLE_SHAPE = /^([a-z][a-z0-9-]*)(?:[.#][A-Za-z0-9_-]+)*$/;

/**
 * Element names a role may be built on.
 *
 * WHY A LIST AND NOT JUST A SHAPE TEST. `thing.png` and `div.card` are the same
 * SHAPE — a name, a dot, a name — so a shape test alone lets a filename through
 * while refusing a path, which is half a guard. Requiring the head to be an
 * element name that browsers actually produce from `tagName.toLowerCase()`
 * separates the two. Custom elements are admitted by their hyphen instead, which
 * the HTML spec requires them to have.
 */
const ELEMENT_NAMES: ReadonlySet<string> = new Set([
  "html", "body", "header", "footer", "main", "nav", "section", "article", "aside", "div",
  "span", "p", "a", "ul", "ol", "li", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6",
  "img", "picture", "figure", "figcaption", "video", "audio", "source", "track", "canvas",
  "button", "input", "textarea", "select", "option", "optgroup", "label", "form", "fieldset",
  "legend", "output", "progress", "meter", "details", "summary", "dialog", "menu",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "col", "colgroup",
  "blockquote", "pre", "code", "em", "strong", "small", "mark", "hr", "br", "i", "b", "u",
  "s", "sup", "sub", "time", "address", "cite", "q", "abbr", "kbd", "samp", "var",
  "iframe", "object", "embed", "template", "slot", "map", "area",
  "svg", "path", "g", "use", "defs", "mask", "marker", "symbol", "circle", "ellipse",
  "rect", "line", "polygon", "polyline", "text", "tspan", "image", "foreignobject",
  "clippath", "lineargradient", "radialgradient", "stop", "filter",
]);

/**
 * A role, or a refusal to print one.
 *
 * WHAT THIS DOES: refuses to print anything that is not shaped like an element
 * role built on a name a browser produces, and prints `an element` instead.
 * A path, a filename, a sentence and a URL all fail it.
 *
 * WHAT THIS DOES NOT DO: it does not check that the element existed, that the
 * class is real, or that the role describes the thing that moved. It is a shape
 * guard on the way out, not a validation of the capture. Its failure direction
 * is deliberate — an unrecognised tag loses its name rather than risking a path
 * in a hashed brief, so a genuinely exotic element reads as `an element` and the
 * rest of its line still says what moved and for how long.
 */
function safeRole(role: string): string {
  const value = role.trim();
  const matched = ROLE_SHAPE.exec(value);
  if (matched === null) return UNNAMED_ROLE;
  const name = matched[1] ?? "";
  return ELEMENT_NAMES.has(name) || name.includes("-") ? value : UNNAMED_ROLE;
}

function entryLine(entry: MotionEntry): string {
  const words: string[] = [`  ${safeRole(entry.role)} — ${FAMILY_PROSE[entry.family]}`];
  if (entry.props.length > 0) words.push(`animating ${entry.props.join(" and ")}`);
  if (!entry.parity) {
    words.push("— presence only: this was observed to run, and its content was NOT compared");
    return words.join(" ");
  }
  words.push(`over ${String(entry.durationMs)}ms`);
  if (entry.easing !== null) words.push(`(${entry.easing})`);
  // Comma-joined separately so the line reads `500ms (ease-out), 120ms apart`
  // rather than `500ms (ease-out) , 120ms apart` — this text is owner-facing and
  // is hashed into the ticket id, so its punctuation is not free-floating.
  const clauses: string[] = [];
  if (entry.staggerMs !== null) clauses.push(`${String(entry.staggerMs)}ms apart across siblings`);
  if (entry.scrollRatio !== null) clauses.push(`moving ${entry.scrollRatio.toFixed(2)}px per px scrolled`);
  if (entry.iterations === null) clauses.push("repeating without end");
  const head = words.join(" ");
  return clauses.length === 0 ? head : `${head}, ${clauses.join(", ")}`;
}

/**
 * What was MEASURED on one entry, in the spelling the brief printed it in.
 *
 * ONLY WHAT THE LINE ACTUALLY PRINTS. A presence-only entry states no duration,
 * no easing and no stagger — {@link entryLine} returns before any of them — so
 * none of them may be listed here either: a criterion could not have been
 * authored from a number the spec seat never saw, and calling it "read off the
 * page" would credit the owner with a fact nothing put in front of anyone.
 *
 * THE ROLE IS THE SAFE ONE, NOT THE RAW ONE, and that is load-bearing rather
 * than tidy. `safeRole` turns a path or a filename into `an element`; listing
 * the raw role here would let its words back in, and `spec-assumptions.ts`
 * QUOTES the shared tokens into the owner's record — so a role the brief refused
 * to print would reappear in `assumptions.md`. The one guard would then have a
 * hole exactly the width of this function.
 *
 * WHAT IS DELIBERATELY ABSENT: the family. Its slug (`scroll-reveal`) and its
 * prose ("revealed once on scroll into view") are the dashboard's own
 * classification and the dashboard's own words. Admitting either would let a
 * criterion match the sentence this file wrote rather than anything read off the
 * page — the cheat `spec-assumptions.ts:referenceSupportFor` states it refuses,
 * and the negative control that pins it goes red the moment they are added.
 */
function measuredWords(entry: MotionEntry): readonly string[] {
  const words: string[] = [safeRole(entry.role), ...entry.props];
  if (!entry.parity) return words;
  words.push(`${String(entry.durationMs)}ms`);
  if (entry.easing !== null) words.push(entry.easing);
  if (entry.staggerMs !== null) words.push(`${String(entry.staggerMs)}ms`);
  if (entry.scrollRatio !== null) words.push(entry.scrollRatio.toFixed(2));
  return words;
}

/**
 * The reading the assumption tracer traces against.
 *
 * WHY THIS EXISTS AT ALL: `orchestrator.ts#recordAssumptions` feeds the tracer
 * `ticketProse(stripPlanBlock(brief))`, which cuts this file's block back off
 * before a single token is matched. Without a reading passed beside the prose,
 * every criterion the spec seat authored out of the motion block came back
 * `inferred` — measured 2026-08-04, with the `reference` bucket in the union and
 * nothing setting it.
 *
 * ONE OBSERVATION PER ENTRY, QUOTING THE LINE THE SPEC SEAT ACTUALLY READ. It is
 * `entryLine`'s own output rather than a paraphrase, so the record the owner gets
 * and the brief the criteria were written from say the same thing in the same
 * words; a paraphrase here would be a second description of the page, free to
 * drift from the one that was graded against.
 *
 * AN EMPTY SPEC STILL PRODUCES A READING, with no observations. That is not the
 * same value as `null` and it is deliberate — `ticket-refs.ts:manifestMotion`
 * keeps "a page was read and nothing moved" apart from "no page was read" — but
 * the two reach the SAME answer in the tracer, because neither is evidence for
 * any criterion. Only the run log distinguishes them.
 */
export function motionReferenceReading(spec: MotionSpec): ReferenceReading {
  const observations: ReferenceObservation[] = spec.entries.map((entry) => ({
    line: entryLine(entry).trim(),
    measured: measuredWords(entry),
  }));
  return { url: spec.url, observations };
}

export function motionBriefLines(spec: MotionSpec): readonly string[] {
  if (spec.entries.length === 0) return [];
  const lines: string[] = [
    MOTION_BLOCK_BEGIN,
    "",
    "This is a partial, automated reading of how a reference page MOVES, taken once",
    "when the ticket was submitted by sampling the rendered page frame by frame. It is",
    "not the page and it is not complete: motion it does not mention may still exist.",
    "",
    "Durations are rounded to the nearest 50ms and stagger to the nearest 20ms, because",
    "an exact measurement differs between two readings of the same page.",
    "",
    "The motion observed:",
  ];
  for (const entry of spec.entries) lines.push(entryLine(entry));
  if (spec.libraries.length > 0) {
    lines.push("", `Motion libraries detected on the reference: ${spec.libraries.join(", ")}.`,
      "This names what the reference used. It is not an instruction to use the same one.");
  }
  // The words "reduced motion" are spelled out rather than left inside the CSS
  // feature name: the sentence is read by a text-only seat authoring criteria,
  // and `prefers-reduced-motion` alone is a token, not a statement about the page.
  lines.push("", spec.respectsReducedMotion
    ? "The reference honours the reduced motion preference: it stops when prefers-reduced-motion is set. Anything built from it must too."
    : "The reference does NOT honour the reduced motion preference: it moves even when prefers-reduced-motion is set. Anything built from it still must.");
  lines.push("", MOTION_BLOCK_END);
  return lines;
}
