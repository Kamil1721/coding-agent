/**
 * The run's label, and the four ways a label like this goes wrong.
 *
 * WRONG ONE: IT INVENTS. The whole safety argument for putting a DERIVED string
 * in the largest type on the canvas is that `ticketLabel` only ever deletes —
 * every word it prints is a word the ticket contained. That claim is not checked
 * by any single example, so the sweep at the bottom checks it over ~220 inputs
 * at once: for every prefix of a real ticket, every token of the label must
 * appear in the input. A paraphrase, a synonym, a helpfully-added noun — each of
 * them turns that test red, and nothing else in this file would notice.
 *
 * WRONG TWO: IT DESTROYS. A short label whose original is unreachable is worse
 * than the ugly truncation it replaced, so the last test does not test the
 * function at all — it calls `RunHud`, finds the `h1`, and asserts the ORIGINAL
 * ticket text is on it. It also asserts the negatives that make that meaningful:
 * the visible child is NOT the raw title, and the tooltip is NOT the label.
 *
 * WRONG THREE: IT RETURNS "". Every degenerate ticket the brief names — one
 * word, empty, only a URL, nothing matching any rule — has its own assertion,
 * and each one asserts the exact string rather than "not empty", because
 * "not empty" is satisfied by a space.
 *
 * WRONG FOUR: IT CUTS MID-WORD. That is the defect being fixed, so the sweep
 * checks the same property from the other side — the label's length never passes
 * the budget, and the tokens are whole words of the input.
 *
 * No browser: `ticketLabel` is a pure function of a string, and `RunHud` is
 * called as a function, so the element assertions read React's element tree
 * without rendering it. Nothing here needs a DOM and nothing here can be green
 * because a DOM was missing.
 */

import { expect, test } from "@playwright/test";
import { isValidElement, type ReactElement, type ReactNode } from "react";

import { RunHud } from "../src/components/canvas/run-hud";
import {
  MAX_LABEL_CHARS,
  MAX_LABEL_WORDS,
  UNTITLED_LABEL,
  ticketLabel,
  ticketTooltip,
} from "../src/lib/ticket-title";
import { RUN_DETAIL } from "./fixtures/run-fixture";

/** The exact string the owner complained about, as the server stored it. */
const OWNERS_TICKET = "I want you to make a copy of t…";

/* ------------------------------------------------------------------ */
/* the complaint                                                      */
/* ------------------------------------------------------------------ */

test.describe("the ticket that started this", () => {
  test("the opener goes, the half-word goes, the ellipsis stays", () => {
    expect(ticketLabel(OWNERS_TICKET)).toBe("Make a copy…");
  });

  test("nothing of the throat-clearing survives anywhere in the label", () => {
    const label = ticketLabel(OWNERS_TICKET);
    // The three failures that produced "I want you to make a copy of t…", each
    // asserted separately so a regression says WHICH rule came undone.
    expect(label.startsWith("I want")).toBe(false);
    expect(label.endsWith("of")).toBe(false);
    expect(label.endsWith("t…")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* filler                                                             */
/* ------------------------------------------------------------------ */

test.describe("openers are peeled off the front", () => {
  test("the request phrasings a person actually types", () => {
    expect(ticketLabel("Please can you build a landing page for a roastery")).toBe(
      "Build a landing page…",
    );
    expect(ticketLabel("Can you please add a dark mode toggle")).toBe(
      "Add a dark mode toggle",
    );
    expect(ticketLabel("I need a landing page for a workshop")).toBe(
      "Landing page for a workshop",
    );
    expect(ticketLabel("We need to fix the spec-seat abort path")).toBe(
      "Fix the spec-seat abort path",
    );
    expect(ticketLabel("Your job is to rewrite the run header")).toBe(
      "Rewrite the run header",
    );
    expect(ticketLabel("Task: build a pricing page")).toBe("Build a pricing page");
    expect(ticketLabel("hey can you copy stripe.com for me")).toBe("Copy stripe.com for me");
  });

  test("the article after an opener goes, the article that opens a sentence stays", () => {
    // "I want a portfolio" is a request for a portfolio; "The pricing page…" is
    // a sentence about a page. Only the first has an opener in front of it, and
    // that is the whole difference the rule keys on.
    expect(ticketLabel("I want a portfolio")).toBe("Portfolio");
    expect(ticketLabel("the pricing page is wrong on mobile")).toBe(
      "The pricing page is wrong…",
    );
  });

  test("a strip that would leave only glue is undone", () => {
    // "I want you to" peels to "to". "To" is a label about nothing, so the
    // owner's words come back instead — the same refusal as the empty case.
    expect(ticketLabel("I want you to")).toBe("I want you to");
    expect(ticketLabel("Please")).toBe("Please");
  });
});

/* ------------------------------------------------------------------ */
/* links                                                              */
/* ------------------------------------------------------------------ */

test.describe("a link becomes its host, in place", () => {
  test("a ticket that is only a URL is named after the site", () => {
    expect(ticketLabel("https://stripe.com/pricing")).toBe("stripe.com");
    expect(ticketLabel("www.stripe.com")).toBe("stripe.com");
    // A loopback preview address keeps its port: `127.0.0.1` and
    // `127.0.0.1:4321` are not the same address to anyone reading this.
    expect(ticketLabel("http://127.0.0.1:4321")).toBe("127.0.0.1:4321");
  });

  test("prose keeps its shape and loses only the query string", () => {
    expect(ticketLabel("Copy https://www.stripe.com/pricing?utm=x")).toBe("Copy stripe.com");
    expect(ticketLabel("make it look like https://linear.app — same type")).toBe(
      "Make it look like linear.app",
    );
  });

  test("a host is never hoisted out of the part that was cut", () => {
    // The tail is discarded, and the label does NOT gain "example.com" from it.
    // Hoisting would mean asserting that "this website" IS that URL, which is a
    // claim the ticket has not made — see the header of `ticket-title.ts`.
    // A comma is deliberately NOT a clause break — it usually carries the
    // object — so the label runs on into "the one" and stops at the word cap,
    // with the host in the discarded tail and nowhere else.
    const label = ticketLabel("Copy this website, the one at https://example.com");
    expect(label).toBe("Copy this website, the one…");
    expect(label.includes("example.com")).toBe(false);
  });

  test("something that only looks like a link is left exactly as typed", () => {
    // `new URL` refuses it, so nothing is substituted and nothing is invented.
    expect(ticketLabel("https://")).toBe("https://");
  });
});

/* ------------------------------------------------------------------ */
/* cutting                                                            */
/* ------------------------------------------------------------------ */

test.describe("cuts land on words", () => {
  test("the first clause wins, and the sentence end is not the dot in a host", () => {
    expect(ticketLabel("Rebuild the dashboard. It should be dark.")).toBe(
      "Rebuild the dashboard",
    );
    expect(ticketLabel("Landing page (dark mode)")).toBe("Landing page");
    // `stripe.com` survives because a sentence end needs whitespace after it.
    expect(ticketLabel("Clone stripe.com now")).toBe("Clone stripe.com now");
  });

  test("a clause cut that would leave one word is refused", () => {
    // The colon rule alone answers "Fix", which is a lost sentence rather than a
    // short one. The whole line is preferred instead.
    expect(ticketLabel("Fix: the thing")).toBe("Fix: the thing");
  });

  test("a cut label never ends on a preposition or an article", () => {
    expect(ticketLabel("Add a test suite to the dashboard client.")).toBe(
      "Add a test suite…",
    );
    expect(ticketLabel("I'd like you to redesign the run canvas so it stops lying")).toBe(
      "Redesign the run canvas…",
    );
  });

  test("an uncut label keeps its own last word, even a preposition", () => {
    // The dangling-word trim runs ONLY after a cut. A ticket that genuinely
    // reads "Sign in" must not become "Sign".
    expect(ticketLabel("Sign in")).toBe("Sign in");
  });

  test("the word cap is a cap on WORDS, and it is adjustable", () => {
    expect(ticketLabel("one two three four five six seven eight")).toBe(
      "One two three four five six…",
    );
    expect(ticketLabel("Rebuild the entire run dashboard from scratch", 3)).toBe(
      "Rebuild the entire…",
    );
  });

  test("the machine's ellipsis is a cut; a person's three dots are punctuation", () => {
    // `titleFromBrief` appends U+2026 to everything over 80 characters, so the
    // token in front of one is a fragment and goes. ASCII dots are the owner
    // typing, so the word in front of them is whole and stays.
    expect(ticketLabel("Rebuild the marketing sit…")).toBe("Rebuild the marketing…");
    expect(ticketLabel("Rebuild the marketing site...")).toBe("Rebuild the marketing site");
  });

  test("one unbreakable token is clamped, and gets exactly one ellipsis", () => {
    const label = ticketLabel("supercalifragilisticexpialidociousandthensome…");
    expect(label).toBe("Supercalifragilisticexpiali…");
    expect(label.includes("……")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* capitals                                                           */
/* ------------------------------------------------------------------ */

test.describe("one capital, and never on a name", () => {
  test("sentence case, not Title Case", () => {
    expect(ticketLabel("rebuild the marketing site")).toBe("Rebuild the marketing site");
  });

  test("identifiers, acronyms and hosts keep the case they were written in", () => {
    expect(ticketLabel("iPhone mockups for pricing")).toBe("iPhone mockups for pricing");
    expect(ticketLabel("SPEC-SEAT abort")).toBe("SPEC-SEAT abort");
    expect(ticketLabel("stripe.com clone")).toBe("stripe.com clone");
  });

  test("the known cosmetic miss, pinned rather than hidden", () => {
    // A lowercase command word at the front IS capitalised. This is asserted so
    // that the docblock's claim and the behaviour cannot drift apart: if someone
    // adds a command allowlist, this test goes red and they must update both.
    expect(ticketLabel("npm test should run from cold")).toBe("Npm test should run from cold");
  });
});

/* ------------------------------------------------------------------ */
/* degenerate                                                         */
/* ------------------------------------------------------------------ */

test.describe("nothing produces an empty label", () => {
  test("an empty ticket, and whitespace that only looks like one", () => {
    expect(ticketLabel("")).toBe(UNTITLED_LABEL);
    expect(ticketLabel("   ")).toBe(UNTITLED_LABEL);
    expect(ticketLabel("\n\n\t")).toBe(UNTITLED_LABEL);
  });

  test("a ticket with no letters in it", () => {
    // "!!!" clause-cuts to "!!" before the last rule catches it; a lone marker
    // leaves nothing at all. Both are named, neither is a run's name.
    expect(ticketLabel("!!!")).toBe(UNTITLED_LABEL);
    expect(ticketLabel("…")).toBe(UNTITLED_LABEL);
    expect(ticketLabel("...")).toBe(UNTITLED_LABEL);
  });

  test("a one-word ticket is that word", () => {
    expect(ticketLabel("portfolio")).toBe("Portfolio");
    expect(ticketLabel("a")).toBe("A");
  });

  test("a ticket where no rule matches is returned as written", () => {
    expect(ticketLabel("Give the client a test suite")).toBe("Give the client a test suite");
  });

  test("the server's own name for a wordless brief survives the round trip", () => {
    // `titleFromBrief` answers "Untitled ticket" for an empty brief, so that
    // string arrives here as ordinary input and must come back unchanged rather
    // than being re-processed into something else.
    expect(ticketLabel(UNTITLED_LABEL)).toBe(UNTITLED_LABEL);
  });
});

/* ------------------------------------------------------------------ */
/* the tooltip                                                        */
/* ------------------------------------------------------------------ */

test.describe("ticketTooltip keeps the original reachable", () => {
  test("the whole brief beats the server's 80-character cut", () => {
    const brief = "I want you to make a copy of this website\nand make the hero bigger";
    expect(ticketTooltip("I want you to make a copy of t…", brief)).toBe(brief);
  });

  test("it is not capped — capping it would recreate the loss", () => {
    const brief = "x".repeat(5_000);
    expect(ticketTooltip("x…", brief)).toHaveLength(5_000);
  });

  test("it falls back to the title, then to the constant", () => {
    expect(ticketTooltip("only a title", "")).toBe("only a title");
    expect(ticketTooltip("", "   ")).toBe(UNTITLED_LABEL);
  });
});

/* ------------------------------------------------------------------ */
/* the element                                                        */
/* ------------------------------------------------------------------ */

/** Depth-first search of a React element tree for the first `<h1>`. */
function findElement(node: ReactNode, tag: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node as readonly ReactNode[]) {
      const hit = findElement(child, tag);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === tag) return node;
  const props = node.props as { readonly children?: ReactNode };
  return props.children === undefined ? null : findElement(props.children, tag);
}

function hudHeading(ticketTitle: string, ticketText: string): {
  visible: unknown;
  tooltip: unknown;
} {
  const hud = RunHud({
    run: { ...RUN_DETAIL, ticketTitle, ticketText },
    model: null,
    nowMs: Date.parse("2026-07-29T09:05:00.000Z"),
    busy: false,
    onCancel: () => undefined,
    onResume: () => undefined,
    onOpenDetail: () => undefined,
  });
  const heading = findElement(hud, "h1");
  // Not an assertion helper being polite: if the chip stops rendering an `h1`,
  // every expectation below would otherwise be checking `undefined` against
  // `undefined` and passing.
  if (heading === null) throw new Error("RunHud rendered no <h1>");
  const props = heading.props as { readonly title?: unknown; readonly children?: unknown };
  return { visible: props.children, tooltip: props.title };
}

test.describe("the chip shows the label and still carries the ticket", () => {
  const TICKET_TITLE = "I want you to make a copy of t…";
  const TICKET_TEXT =
    "I want you to make a copy of this website https://example.com\nand make the hero bigger.";

  test("the heading renders the label, not the raw title", () => {
    const { visible } = hudHeading(TICKET_TITLE, TICKET_TEXT);
    expect(visible).toBe("Make a copy…");
    // The negative that makes the line above mean something: before this change
    // the heading WAS the raw string, and that assertion alone would still pass
    // if `ticketLabel` were reverted to the identity function.
    expect(visible).not.toBe(TICKET_TITLE);
  });

  test("THE ORIGINAL IS STILL ON THE ELEMENT — the stored ticket, unmodified", () => {
    const { visible, tooltip } = hudHeading(TICKET_TITLE, TICKET_TEXT);
    expect(tooltip).toBe(TICKET_TEXT);
    // A tooltip that repeats the label would be a summary with no way back to
    // what it summarised, which is the failure this whole assertion exists for.
    expect(tooltip).not.toBe(visible);
  });

  test("a wordless ticket names itself rather than showing the run id", () => {
    const { visible, tooltip } = hudHeading("", "");
    expect(visible).toBe(UNTITLED_LABEL);
    expect(visible).not.toBe(RUN_DETAIL.runId);
    expect(tooltip).toBe(UNTITLED_LABEL);
  });
});

/* ------------------------------------------------------------------ */
/* the sweep                                                          */
/* ------------------------------------------------------------------ */

test.describe("properties that hold for every prefix of a real ticket", () => {
  // Every prefix, with and without the server's truncation marker: 220 inputs,
  // including every possible mid-word cut position.
  const TICKET =
    "I want you to make a copy of this website https://www.stripe.com/pricing and make it dark";
  const INPUTS: string[] = [];
  for (let end = 0; end <= TICKET.length; end += 1) {
    INPUTS.push(TICKET.slice(0, end), `${TICKET.slice(0, end)}…`);
  }

  test("never empty, never over budget, never more words than the cap", () => {
    for (const input of INPUTS) {
      const label = ticketLabel(input);
      expect(label, `empty label for ${JSON.stringify(input)}`).not.toBe("");
      expect(label.trim(), `blank label for ${JSON.stringify(input)}`).not.toBe("");
      // +1 for the ellipsis the budget does not count.
      expect(label.length, `too long for ${JSON.stringify(input)}`).toBeLessThanOrEqual(
        MAX_LABEL_CHARS + 1,
      );
      expect(
        label.split(/\s+/).filter((word) => word !== "").length,
        `too many words for ${JSON.stringify(input)}`,
      ).toBeLessThanOrEqual(MAX_LABEL_WORDS);
    }
  });

  /** Whole words of a string, punctuation trimmed off each end, lowercased. */
  function bareWords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== "")
      .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
  }

  test("never half a word — the defect this whole file exists for", () => {
    // MEASURED, NOT ASSUMED: this check was run against a mutant that replaces
    // `ticketLabel` with `raw.slice(0, 27) + "…"`, the character cut that
    // produced "copy of t…". It reports 69 partial-word tokens on that mutant
    // and none on the real function. A "token is a substring of the input"
    // check does NOT catch it — every prefix is a substring — which is why the
    // membership below is against WHOLE words.
    for (const input of INPUTS) {
      const label = ticketLabel(input);
      if (label === UNTITLED_LABEL) continue;
      const whole = bareWords(input);
      // The one exemption, and it is narrow: a token may be a fragment of a
      // LINK, because `https://www.stripe.com/pricing` legitimately reduces to
      // `stripe.com`. Nothing else in the sentence gets to be a fragment.
      const links = input
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.startsWith("http") || word.startsWith("www."));
      for (const token of label.split(/[\s…]+/).filter((word) => word !== "")) {
        const bare = token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        const partial = !whole.includes(bare) && !links.some((word) => word.includes(bare));
        expect(
          partial,
          `${JSON.stringify(label)} holds the fragment ${JSON.stringify(token)} of ${JSON.stringify(input)}`,
        ).toBe(false);
      }
    }
  });

  test("never a word the ticket did not contain", () => {
    for (const input of INPUTS) {
      const label = ticketLabel(input);
      if (label === UNTITLED_LABEL) continue; // the one string it is allowed to author
      for (const token of label.split(/[\s…]+/).filter((word) => word !== "")) {
        // Case-insensitive because the one edit this function makes is a capital
        // letter; substring because `www.stripe.com/pricing` legitimately
        // becomes the substring `stripe.com`.
        expect(
          input.toLowerCase().includes(token.toLowerCase()),
          `${JSON.stringify(label)} invented ${JSON.stringify(token)} from ${JSON.stringify(input)}`,
        ).toBe(true);
      }
    }
  });
});
