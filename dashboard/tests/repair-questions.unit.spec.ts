/**
 * THE REPAIR LANE'S QUESTIONS PANEL — the grouping, and the one row that must
 * never be folded away.
 *
 * WHY EVERY TEST HERE NAMES A MUTATION AND WHY EVERY ONE OF THEM WAS RUN. This
 * repository's catalogued signature defect is a check that can only observe
 * success, and its second-order version — a docblock claiming a mutation nobody
 * applied — has shipped seventeen times. So each `test.describe` below records the
 * exact edit that reddens it, and the seven listed in the block at the bottom of
 * this header were applied to `repair-questions-panel.tsx`, watched go red,
 * reverted, and watched go green again on 2026-08-16.
 *
 * THE CLAIM THAT MATTERS IS NOT "GROUPING WORKS". It is that an `OWNER` question
 * cannot end up behind a fold. That claim has TWO independent failure sites and a
 * test at either one alone is green while the panel is broken at the other:
 *
 *   · `groupRepairQuestions` could file the row under `confirmed`.
 *   · the render could nest the NEEDS YOU block inside the `<details>`.
 *
 * Both are tested, separately, and both mutations were run separately.
 *
 * THE FIXTURE THAT DOES THE WORK IS {@link OWNER_CONFIRMED} — an `OWNER`-tagged
 * question whose `outcome` is `CONFIRMED`. It is not a contrived shape: `outcome`
 * has no `OWNER` member (see the panel's type), so the writer of a record has to
 * put SOMETHING there for a question no evidence source could settle, and
 * `CONFIRMED` is what a naive writer picks. Group on `outcome` alone — the obvious
 * simplification, and the mutation this file names first — and that row lands in
 * the collapsed group. The owner's queue then loses a row while every count on
 * screen stays internally consistent, which is the failure mode nothing else here
 * would notice.
 *
 * THE QUESTIONS THEMSELVES ARE QUOTED, NOT INVENTED. The `CODE` row is
 * `docs/DESIGN-repair-lane-2026-08-16.md` §11.2's own worked example, down to the
 * citation; the `OWNER` row is the owner's question of 2026-08-12 that §10.4 lists
 * in the seeded corpus and that day's session doc calls the sharpest question of
 * the day; the `http.ts:2016` row is §12.2's first blocker. A fixture invented for
 * a test proves the test can pass on invented data.
 *
 * NO BROWSER, AND NO DOM. Everything below is a pure function of a props object:
 * the panel holds no state, reads no clock and fetches nothing, so it is called as
 * a function and the tree it returns is read directly. See {@link hostNodes} for
 * the one wrinkle that makes that possible under this runner.
 *
 * ─── THE MUTATIONS, AS RUN, WITH WHAT EACH ONE REDDENED ───
 *
 * Applied one at a time by exact substring replacement from a saved pristine copy,
 * run, reverted, and the file's checksum compared against that copy afterwards —
 * so "reverted" is measured rather than assumed.
 *
 *   M1   `groupRepairQuestions`: delete the `source === "OWNER"` arm, leaving a
 *        switch on `outcome` alone.                                    RED, 6 tests
 *   M2   the render: also draw the NEEDS YOU rows inside the `<details>`.
 *                                                                      RED, 2 tests
 *   M2b  the render: stop drawing the pinned block, so the queue exists ONLY
 *        inside the fold.                                              RED, 5 tests
 *   M3   `groupRepairQuestions`: file `UNANSWERED` under `confirmed`.  RED, 4 tests
 *   M4   the render: draw the earned-nothing sentence unconditionally. RED, 1 test
 *   M5   the render: keep the earned-nothing sentence in the tree but mark it
 *        `hidden`.                                                     RED, 1 test
 *   M6   `answerLine`: return the same sentence for both kinds of silence.
 *                                                                      RED, 1 test
 *   M7   the render: draw nothing when an answered row has no citation. RED, 1 test
 *
 * M5 IS RECORDED THE WAY IT IS BECAUSE IT CAUGHT A HOLE IN THIS FILE. Deleting the
 * sentence outright reddened immediately; the `hidden` variant left the whole suite
 * GREEN, because {@link textOf} concatenated every leaf in the tree whether a reader
 * could see it or not. The panel would have said nothing and this file would have
 * agreed that it did. {@link textOf} and {@link locate} now both skip `hidden`
 * subtrees, which is what makes the M5 line above true.
 */

import { expect, test } from "@playwright/test";

import {
  RepairQuestionsPanel,
  askerEarnedNothing,
  groupRepairQuestions,
  type RepairQuestion,
} from "../src/components/canvas/repair-questions-panel";

/* ------------------------------------------------------------------ */
/* the corpus                                                          */
/* ------------------------------------------------------------------ */

/** The owner's own question, 2026-08-12. No evidence source can settle it. */
const OWNER_CONFIRMED: RepairQuestion = {
  question: "is the model being restricted too much?",
  source: "OWNER",
  answer: "",
  citation: "",
  // The trap. A writer with no OWNER member on `outcome` picks this.
  outcome: "CONFIRMED",
};

/** §11.2's worked row, verbatim. */
const CHANGED: RepairQuestion = {
  question: "is details.error the thrown error?",
  source: "CODE",
  answer: "No. node wraps it in ERR_TEST_FAILURE; the real error is on .cause.",
  citation: "scorer-container.ts:1218",
  outcome: "CHANGED_DIAGNOSIS",
};

/** §12.2's first blocker, asked and confirmed. The boring majority. */
const CONFIRMED: RepairQuestion = {
  question: "is enqueueSupervisorTicket the only writer of supervisor_tickets?",
  source: "CODE",
  answer: "Yes. Its sole production caller is the tickets route.",
  citation: "http.ts:2016",
  outcome: "CONFIRMED",
};

/** §12.1's answered-by-hand question, here in the state it was in BEFORE anyone ran it. */
const UNANSWERED: RepairQuestion = {
  question: "does APPLY commit, or only write?",
  source: "EXPERIMENT",
  answer: "",
  citation: "",
  outcome: "UNANSWERED",
};

/** An answer with no evidence behind it — §10.3's "guessed with extra steps". */
const UNCITED: RepairQuestion = {
  question: "does a restart re-run a terminal ticket?",
  source: "CODE",
  answer: "Yes, reconcileOnBoot stamps interrupted and nothing clears it.",
  citation: "",
  outcome: "CHANGED_DIAGNOSIS",
};

const FULL_SET: readonly RepairQuestion[] = [
  OWNER_CONFIRMED,
  CHANGED,
  CONFIRMED,
  UNANSWERED,
];

/* ------------------------------------------------------------------ */
/* reading the tree                                                    */
/* ------------------------------------------------------------------ */

/**
 * One node of the JSX tree the panel returns, in whichever shape the loader that
 * compiled the `.tsx` produced.
 *
 * MEASURED UNDER THIS RUNNER RATHER THAN ASSUMED, and the measurement is the same
 * one `ticket-title.unit.spec.ts`'s header records: Playwright's transform pins
 * `jsxImportSource` to its own package, so a node is `{ __pw_type: "jsx", type,
 * props }` with no `$$typeof` and `isValidElement` is false for every one of them.
 * Nothing here may key on `$$typeof`.
 */
interface JsxNode {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>> & { readonly children?: unknown };
}

function asNode(value: unknown): JsxNode | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly type?: unknown; readonly props?: unknown };
  if (candidate.type === undefined) return null;
  if (typeof candidate.props !== "object" || candidate.props === null) return null;
  return { type: candidate.type, props: candidate.props as JsxNode["props"] };
}

/** A real element, with its function components already flattened away. */
interface HostNode {
  /** `section`, `p`, `details` … */
  readonly tag: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly HostNode[];
  /** The string and number leaves directly inside this element, in order. */
  readonly ownText: readonly string[];
}

/**
 * The tree, reduced to elements a browser would render.
 *
 * WHY THIS CALLS FUNCTION COMPONENTS. Calling `RepairQuestionsPanel(...)` returns
 * ONE level of JSX: a `<QuestionRow question={…} />` inside it is a node whose
 * `type` is the function and whose `props.children` is `undefined`. MEASURED by
 * dumping the tree before this file was written — the panel's rows showed up as
 * `FN:QuestionRow` with an empty child list, so a walk that only follows
 * `props.children` sees no question text at all and every assertion about a row
 * would pass vacuously against a panel that renders nothing.
 *
 * So a node whose `type` is a function is INVOKED with its own props and its result
 * walked in its place. That is only sound because every component in the panel is
 * pure and hook-free — and it is therefore also a check on that property: add one
 * `useState` to any of them and this throws "Invalid hook call" instead of quietly
 * passing.
 *
 * A NON-FUNCTION, NON-STRING `type` IS A FRAGMENT and is walked THROUGH rather than
 * called. Also measured: under this runner `<>…</>` compiles to a node whose `type`
 * is an object, not the `Symbol(react.fragment)` that `react/jsx-runtime` exports,
 * so the test is "is it a string" and "is it a function" — never an identity
 * comparison against a Fragment marker this runner does not use.
 */
function hostNodes(value: unknown): readonly HostNode[] {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).flatMap((child) => hostNodes(child));
  }
  const node = asNode(value);
  if (node === null) return [];
  if (typeof node.type === "function") {
    const render = node.type as (props: unknown) => unknown;
    return hostNodes(render(node.props));
  }
  if (typeof node.type !== "string") return hostNodes(node.props.children);
  return [
    {
      tag: node.type,
      props: node.props,
      children: hostNodes(node.props.children),
      ownText: leafText(node.props.children),
    },
  ];
}

/** The string and number leaves at ONE level, with fragments flattened into it. */
function leafText(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).flatMap((child) => leafText(child));
  }
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  const node = asNode(value);
  if (node === null) return [];
  // A fragment is not an element: its leaves belong to whatever contains it.
  if (typeof node.type === "function") {
    const render = node.type as (props: unknown) => unknown;
    return leafText(render(node.props));
  }
  if (typeof node.type !== "string") return leafText(node.props.children);
  return [];
}

/**
 * Everything READABLE inside an element, its descendants included.
 *
 * `hidden` SUBTREES CONTRIBUTE NOTHING, and that is not a nicety — it is a hole
 * this file had and the mutation loop found. The first version simply concatenated
 * every leaf, so a mutation that kept the §11.3 sentence in the tree and added
 * `hidden` to it left the whole suite GREEN while the panel said nothing to the
 * reader. `hidden` is the HTML attribute: `display: none`, out of the layout and
 * out of the accessibility tree, which is exactly how `rail.tsx:513` hides a whole
 * panel while keeping it mounted. A text extractor that counts it as visible is a
 * check that cannot observe the failure it exists for.
 */
function textOf(node: HostNode): string {
  if (node.props["hidden"] === true) return "";
  return [
    node.ownText.join(""),
    ...node.children.map((child) => textOf(child)),
  ].join("");
}

/** The whole panel as one string, for "does this sentence appear at all". */
function panelText(questions: readonly RepairQuestion[]): string {
  return hostNodes(RepairQuestionsPanel({ questions }))
    .map((node) => textOf(node))
    .join("");
}

/**
 * Every ancestor chain that ends at a matching element, outermost first.
 *
 * The ancestors are the whole point: "is this row inside a `<details>`" is a
 * question about what is ABOVE it, and a search that only returns the element
 * cannot answer it.
 */
function pathsTo(
  nodes: readonly HostNode[],
  matches: (node: HostNode) => boolean,
  trail: readonly HostNode[] = [],
): readonly (readonly HostNode[])[] {
  const found: (readonly HostNode[])[] = [];
  for (const node of nodes) {
    const here = [...trail, node];
    if (matches(node)) found.push(here);
    found.push(...pathsTo(node.children, matches, here));
  }
  return found;
}

/**
 * The single element whose OWN text is exactly `text`, with its ancestors.
 *
 * THROWS WHEN THERE IS NO SUCH ELEMENT, and that guard is the negative control for
 * every "…and it is not inside a `<details>`" assertion below. Without it, a panel
 * that rendered no rows at all would satisfy "no `details` above the owner's
 * question" perfectly, and the mutation these tests exist for would go GREEN. This
 * is the same guard, for the same reason, as `ticket-title.unit.spec.ts`'s
 * `throw new Error("RunHud rendered no <h1>")`.
 */
function locate(
  questions: readonly RepairQuestion[],
  text: string,
): readonly HostNode[] {
  const tree = hostNodes(RepairQuestionsPanel({ questions }));
  const hits = pathsTo(tree, (node) => node.ownText.join("") === text).filter(
    // A row inside a `hidden` subtree is mounted and unreadable, which for every
    // claim in this file is the same as absent. See {@link textOf}.
    (path) => !path.some((node) => node.props["hidden"] === true),
  );
  if (hits.length === 0) throw new Error(`the panel rendered no element reading ${JSON.stringify(text)}`);
  if (hits.length > 1) throw new Error(`${String(hits.length)} elements read ${JSON.stringify(text)}`);
  return hits[0] as readonly HostNode[];
}

/**
 * The ancestor path to a node by its `data-testid`.
 *
 * WHY NOT {@link locate}: that matches on exact own-text, and a sentence written
 * across several JSX lines arrives as several text children, so no single node's
 * `ownText.join("")` equals the sentence a reader sees. A testid is the stable
 * handle, and using it means the assertion survives a rewording of the prose —
 * which is right, because the claim is about PLACEMENT, not wording.
 */
function locateByTestId(questions: readonly RepairQuestion[], testId: string): readonly HostNode[] {
  const tree = hostNodes(RepairQuestionsPanel({ questions }));
  const hits = pathsTo(tree, (node) => node.props["data-testid"] === testId).filter(
    (path) => !path.some((node) => node.props["hidden"] === true),
  );
  if (hits.length === 0) throw new Error(`the panel rendered no element with data-testid ${JSON.stringify(testId)}`);
  if (hits.length > 1) throw new Error(`${String(hits.length)} elements carry data-testid ${JSON.stringify(testId)}`);
  return hits[0] as readonly HostNode[];
}

/** The `data-group` of every group container, in the order they are drawn. */
function groupOrder(questions: readonly RepairQuestion[]): readonly string[] {
  const tree = hostNodes(RepairQuestionsPanel({ questions }));
  return pathsTo(tree, (node) => typeof node.props["data-group"] === "string").map(
    (path) => String((path[path.length - 1] as HostNode).props["data-group"]),
  );
}

/* ------------------------------------------------------------------ */
/* the grouping                                                        */
/* ------------------------------------------------------------------ */

test.describe("grouping is source-first, then outcome", () => {
  /**
   * MUTATION M1: in `groupRepairQuestions`, delete the `source === "OWNER"` arm so
   * the function switches on `outcome` alone. RUN — this test reddens on
   * `expect(needsYou).toContain(OWNER_CONFIRMED)`.
   */
  test("an OWNER question is the owner's queue even when its outcome says CONFIRMED", () => {
    const groups = groupRepairQuestions(FULL_SET);
    expect(groups.needsYou).toContain(OWNER_CONFIRMED);
    // The negative half, and it is not a restatement: a grouping function that
    // pushed the row into BOTH lists would satisfy the line above.
    expect(groups.confirmed).not.toContain(OWNER_CONFIRMED);
    expect(groups.changed).not.toContain(OWNER_CONFIRMED);
  });

  /**
   * MUTATION M3: file `UNANSWERED` under `confirmed`. RUN — reddens here.
   */
  test("an unanswered question is never filed as a confirmation", () => {
    const groups = groupRepairQuestions(FULL_SET);
    expect(groups.needsYou).toContain(UNANSWERED);
    expect(groups.confirmed).not.toContain(UNANSWERED);
  });

  test("the two that are what they say they are land where they say", () => {
    const groups = groupRepairQuestions(FULL_SET);
    expect(groups.changed).toEqual([CHANGED]);
    expect(groups.confirmed).toEqual([CONFIRMED]);
  });

  /**
   * A PARTITION, CHECKED AS ONE. Any mutation that drops a row — a stray `continue`,
   * a filter, a mis-ordered arm that matches nothing — reddens here even when the
   * three counts still look plausible on screen.
   */
  test("every question lands in exactly one group, and none is lost", () => {
    const groups = groupRepairQuestions(FULL_SET);
    const all = [...groups.needsYou, ...groups.changed, ...groups.confirmed];
    expect(all).toHaveLength(FULL_SET.length);
    expect(new Set(all).size).toBe(FULL_SET.length);
    for (const question of FULL_SET) expect(all).toContain(question);
  });

  test("order inside a group is the record's order, not a sort", () => {
    const second: RepairQuestion = { ...OWNER_CONFIRMED, question: "who decides?" };
    const groups = groupRepairQuestions([second, OWNER_CONFIRMED]);
    expect(groups.needsYou).toEqual([second, OWNER_CONFIRMED]);
  });

  test("an empty record produces three empty groups rather than throwing", () => {
    const groups = groupRepairQuestions([]);
    expect(groups.needsYou).toHaveLength(0);
    expect(groups.changed).toHaveLength(0);
    expect(groups.confirmed).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* the fold                                                            */
/* ------------------------------------------------------------------ */

test.describe("the owner's queue is never behind a fold", () => {
  /**
   * THE CLAIM THIS WHOLE FILE EXISTS FOR, asserted about the RENDER rather than
   * about the grouping — the two can disagree.
   *
   * MUTATION M2: move the NEEDS YOU rows inside the `<details>` in
   * `RepairQuestionsPanel`. RUN — every grouping test above stays GREEN and this
   * one reddens, which is the reason it is written separately from them.
   */
  test("the OWNER question is on the panel, and no <details> sits above it", () => {
    // `locate` throws if the row is absent, so the negative below cannot be
    // satisfied by a panel that rendered nothing.
    const path = locate(FULL_SET, OWNER_CONFIRMED.question);
    expect(path.map((node) => node.tag)).not.toContain("details");
  });

  test("a confirmation IS behind the fold — the control for the line above", () => {
    // Without this, "no details above the owner's question" would also be true of a
    // panel with no `<details>` at all, and M2's inverse — un-collapsing the boring
    // majority — would go unnoticed.
    const path = locate(FULL_SET, CONFIRMED.question);
    expect(path.map((node) => node.tag)).toContain("details");
  });

  test("the queue is drawn first, and the confirmations last", () => {
    expect(groupOrder(FULL_SET)).toEqual(["needs-you", "changed", "confirmed"]);
  });

  test("the unanswered question is in the queue on screen, not only in the data", () => {
    const path = locate(FULL_SET, UNANSWERED.question);
    expect(path.map((node) => node.tag)).not.toContain("details");
    expect(
      path.some((node) => node.props["data-group"] === "needs-you"),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* §11.3 — the metric that can kill the feature                        */
/* ------------------------------------------------------------------ */

test.describe("a round of asking that returned nothing says so", () => {
  const ALL_CONFIRMED: readonly RepairQuestion[] = [
    CONFIRMED,
    { ...CONFIRMED, question: "is the ticket route the only caller?" },
  ];

  test("the predicate holds when every question confirmed", () => {
    expect(askerEarnedNothing(groupRepairQuestions(ALL_CONFIRMED))).toBe(true);
  });

  test("and does not hold when one changed the diagnosis, or one came back", () => {
    expect(askerEarnedNothing(groupRepairQuestions([...ALL_CONFIRMED, CHANGED]))).toBe(
      false,
    );
    expect(
      askerEarnedNothing(groupRepairQuestions([...ALL_CONFIRMED, OWNER_CONFIRMED])),
    ).toBe(false);
  });

  test("an empty record is not the same claim, and the predicate refuses it", () => {
    // "Nobody asked anything" is not evidence that asking is worthless.
    expect(askerEarnedNothing(groupRepairQuestions([]))).toBe(false);
  });

  /**
   * MUTATION M5: delete the sentence from the render. RUN — reddens here.
   * MUTATION M4: draw it unconditionally. RUN — reddens on the next test.
   */
  test("the panel prints it, above the fold rather than inside it", () => {
    /*
     * CORRECTED 2026-08-16 — THIS TEST COULD NOT FAIL FOR ITS OWN TITLE.
     *
     * It asserted two things and neither constrained placement. `panelText`
     * reaches through `<details>` unconditionally (`textOf` has no `open`
     * check, deliberately, because for every OTHER claim in this file "mounted
     * and collapsed" is still rendered), so a sentence hidden behind the fold
     * counted as printed. And the second assertion located the CONFIRMED
     * QUESTION, not the sentence — it proved the question sits inside a
     * `<details>`, which was never in doubt and is not what the title claims.
     *
     * The sentence is the panel's declaration that Codex-as-asker earned
     * nothing this round (design §11.3). Rendering it inside the fold it
     * describes would be the feature quietly declining to display its own
     * failure — the exact defect this repository is named for, committed by the
     * component whose job is to expose it.
     *
     * MUTATION: move the sentence inside the CONFIRMED `<details>` in
     * `repair-questions-panel.tsx` -> the ancestor assertion below goes RED.
     * Under the old assertions that same move stayed GREEN.
     */
    const path = locateByTestId(ALL_CONFIRMED, "repair-questions-earned-nothing");
    expect(path.map((node) => node.tag)).not.toContain("details");

    // AND IT IS STILL ACTUALLY DRAWN — the control, so "not inside a fold"
    // cannot be satisfied by not rendering it at all.
    expect(panelText(ALL_CONFIRMED)).toContain("this round of asking returned nothing");
  });

  test("it is silent when something changed — the half that makes it mean anything", () => {
    expect(panelText(FULL_SET)).not.toContain("this round of asking returned nothing");
  });

  test("both counts are on the caption, and they are this run's counts", () => {
    const text = panelText(FULL_SET);
    expect(text).toContain("1 changed the diagnosis");
    expect(text).toContain("2 need you");
  });
});

/* ------------------------------------------------------------------ */
/* the degenerate rows                                                 */
/* ------------------------------------------------------------------ */

test.describe("nothing to show is a finding, not a blank", () => {
  test("no questions at all gets its own sentence", () => {
    const text = panelText([]);
    expect(text).toContain("Nothing was asked");
    // And NOT the other sentence: the two claims are different and the panel must
    // not make the stronger one from an empty list.
    expect(text).not.toContain("this round of asking returned nothing");
  });

  test("the section keeps its heading when it has nothing to list", () => {
    // A section that vanishes leaves a reader unable to tell "asked nothing" from
    // "this panel is broken".
    const tree = hostNodes(RepairQuestionsPanel({ questions: [] }));
    expect(pathsTo(tree, (node) => node.tag === "h4")).toHaveLength(1);
    expect(panelText([])).toContain("Questions");
  });

  test("an empty list draws no group containers and no fold", () => {
    expect(groupOrder([])).toEqual([]);
    const tree = hostNodes(RepairQuestionsPanel({ questions: [] }));
    expect(pathsTo(tree, (node) => node.tag === "details")).toHaveLength(0);
  });
});

test.describe("the two silences are different facts and get different words", () => {
  /**
   * MUTATION M6: make `answerLine` return one sentence for both. RUN — reddens on
   * the `not.toContain` below, which is the half that carries the claim.
   */
  test("an unanswered EXPERIMENT row says which source it promised and did not deliver", () => {
    const text = panelText([UNANSWERED]);
    expect(text).toContain("Not answered, although this repair named EXPERIMENT");
    // An OWNER row's sentence must not be reused here: this row is a defect and
    // that one is the system working as designed.
    expect(text).not.toContain("this one is yours");
  });

  test("an OWNER row with no answer is a handover, not a defect", () => {
    const text = panelText([OWNER_CONFIRMED]);
    expect(text).toContain("this one is yours");
    expect(text).not.toContain("Not answered, although this repair named");
  });

  /**
   * MUTATION M7: render nothing when an answered row has no citation. RUN —
   * reddens here.
   */
  test("an answer that cites nothing is marked as citing nothing", () => {
    expect(panelText([UNCITED])).toContain("No citation");
    // The control: a row that DOES cite must not be marked, or the flag is noise
    // and a reader learns to ignore it.
    expect(panelText([CHANGED])).not.toContain("No citation");
    expect(panelText([CHANGED])).toContain("scorer-container.ts:1218");
  });

  test("an OWNER row is exempt — it has nothing to cite by definition", () => {
    // §10.3: OWNER is the ABSENCE of the four evidence sources, so demanding a
    // citation from it would be demanding evidence the tag exists to say is absent.
    expect(panelText([{ ...OWNER_CONFIRMED, answer: "your call" }])).not.toContain(
      "No citation",
    );
  });
});

/* ------------------------------------------------------------------ */
/* the asker                                                           */
/* ------------------------------------------------------------------ */

test.describe("the asker is stated once, because the record cannot say it per row", () => {
  test("the caption names Codex, and no row repeats it", () => {
    const text = panelText(FULL_SET);
    expect(text).toContain("Asked by Codex");
    // Once, not once per row. Four questions and five mentions of the asker is the
    // wallpaper §11.2 exists to prevent.
    expect(text.split("Asked by Codex")).toHaveLength(2);
  });

  test("the source tag on each row is the EVIDENCE source, not the asker", () => {
    // The distinction §11.2's worked row draws: Codex asked it, CODE answered it.
    const text = panelText([CHANGED]);
    expect(text).toContain("CODE");
    expect(text).not.toContain("CODEX");
  });
});

/* =========================================================================
 * THE SERVER'S REAL SHAPE, NOT THE ONE THE FIXTURES USE
 *
 * Found 2026-08-16 by a debugfix lens. `repair-questions.ts`'s `OwnerQuestion`
 * declares `answer: null` and `citation: null` — literally null, not `""` — and
 * this panel's mirror declared both `string`. `blank()` then called `.trim()` on
 * null and the component THREW on the one row the panel exists to pin above the
 * fold: the owner's own queue.
 *
 * EVERY FIXTURE ABOVE USES `""`, which is why twenty-five green tests could not
 * see it. That is this repository's signature defect wearing a type annotation:
 * the suite could only observe the shapes it invented, and never the shape the
 * producer actually sends.
 * ====================================================================== */

test.describe("the panel survives the shape the server really sends", () => {
  /** The server's OwnerQuestion, field for field, nulls included. */
  const SERVER_OWNER = {
    question: "should an earned DID NOT PASS re-queue the build?",
    source: "OWNER",
    answer: null,
    citation: null,
    outcome: "UNANSWERED",
    asker: "codex",
    claimId: "c-1",
    why: "no evidence source can settle it",
  } as unknown as RepairQuestion;

  /**
   * MUTATION: revert `blank` to `(value: string) => value.trim() === ""` and the
   * mirror's fields to `string` -> this throws a TypeError and goes RED. Under
   * the old fixtures the same revert stayed green.
   */
  test("an OWNER row with the server's nulls renders instead of throwing", () => {
    const text = panelText([SERVER_OWNER]);
    expect(text).toContain("should an earned DID NOT PASS re-queue the build?");
    expect(text).toContain("No answer — this one is yours.");
  });

  test("and it is still pinned in NEEDS YOU, not folded away", () => {
    const path = locate([SERVER_OWNER], SERVER_OWNER.question);
    expect(path.map((node) => node.tag)).not.toContain("details");
  });
});
