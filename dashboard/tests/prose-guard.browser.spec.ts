/**
 * THE GUARD — two rules over every word this product writes about itself.
 *
 * WHY IT EXISTS. On 2026-08-04 the owner said two things about the app. On the
 * prose: "are you also clearning up these long explanations for everything.
 * These are through the app. They explain everything. If something really must
 * have a explanation it should have little i icon to when i hover over it brings
 * it up". On the vocabulary: "spec seat audit seat freeze. These dont really
 * mean anything to me. For example PLan means something, orchestrator means
 * something, ui agent etc" and "I want it userfriendly and simple interms of no
 * jargon".
 *
 * Six lanes then rewrote copy across eighteen components and removed about 1,650
 * words. NOTHING STOPPED IT COMING BACK. Every existing check in this repository
 * asserts a NAMED string — `rail.browser.spec.ts` pins six labels,
 * `server/src/graph.test.ts` pins the stage cards, `panel-copy.browser.spec.ts`
 * pins one canary sentence per panel. All of them are green while somebody adds
 * a NEW paragraph in a NEW place, because none of them is looking at the new
 * paragraph. That is the actual failure mode, and it is why both rules below are
 * SHAPED AS BUDGETS OVER EVERYTHING RENDERED rather than as lists of forbidden
 * strings. A list of strings only ever catches the sentence somebody already
 * deleted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE LINE BETWEEN CHROME AND DATA IS DRAWN, AND WHY IT HAS TO BE
 *
 * A whole-page scan for either rule cannot work. This harness's own ticket reads
 * "Add a test suite to the dashboard client" and its title is "Give the client a
 * test SUITE"; the server writes "the spec SEAT (default) call … failed" into
 * `failureReason`, which the Result panel prints verbatim as evidence; a chat
 * message is whatever the owner typed; a diff is a diff. A guard that reddens on
 * the owner's own prose is a guard somebody deletes inside a week, and the real
 * drift comes back with it.
 *
 * SO EVERY STRING THE API SERVED FOR THIS RUN IS DATA, AND EVERYTHING ELSE ON
 * SCREEN IS CHROME. The separation is mechanical, not a hand-picked selector
 * list:
 *
 *   1. `page.on("response")` records EVERY JSON body the page fetched from the
 *      fixture API while the test drove it — the run detail, the graph, the
 *      workspace tree, each file's contents, the chat transcript. Nothing is
 *      hard-coded; a panel that fetches a new endpoint is covered the day it
 *      does.
 *   2. `ticketLabel()`'s derived heading is added by hand, because it is NOT
 *      served: Overview's heading is a CUT of `ticketTitle` made in the browser,
 *      so subtracting the whole title leaves the cut on screen. It is still the
 *      owner's words with some removed.
 *   3. A rendered block whose whole text is CONTAINED IN a served string is
 *      data, and scores zero. This direction matters as much as the other one:
 *      `plan-dialogue.tsx` renders "Which of the two images you attached is the
 *      one at the top?" out of a served message that reads "PQ-3: Which of the
 *      two images…", so subtracting served strings from the block would have
 *      left the owner's own question counted as the product's prose.
 *   4. Otherwise each served string is CUT OUT of the block and what survives is
 *      the product's own voice. That is what both rules are applied to.
 *
 * TWO CALIBRATIONS THAT WERE MEASURED RATHER THAN CHOSEN.
 *
 *   Only served strings of 12 characters or more are cut wholesale. The fixture
 *   serves `"running"`, `"pass"` and `"builder"` as field VALUES, and cutting
 *   single common words out of the product's prose is how a check like this
 *   quietly stops reading it.
 *
 *   A SHORT served string is cut only if it is ITSELF a banned word. The
 *   workspace tree contains a file named `.env`; without this exemption the
 *   guard's first run reported the owner's own filename as jargon. That is the
 *   one case the exemption exists for and nothing wider.
 *
 * THE LIMIT, NAMED RATHER THAN HIDDEN: matching is exact-substring, so a
 * TRUNCATED rendering of served text (`MonoPath`'s ellipsis) is not recognised
 * as the string it was cut from. No fixture path is long enough for that to
 * matter today. If one ever is, subtract it — do not delete the check.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A "BLOCK" IS, AND WHY A PASSAGE IS MEASURED AND NOT A PARAGRAPH
 *
 * A block is the INNERMOST element with a non-inline computed display: the
 * element that actually draws a line of text. It is found by layout, not by tag
 * name, because this app is Tailwind divs the whole way down and a rule written
 * over `<p>` would miss most of it.
 *
 * A PASSAGE is every prose block sharing one parent, added together. The wall
 * the owner screenshotted was TWO paragraphs of 53 and 50 words under one
 * `<fieldset>`, and a per-paragraph rule set loose enough to permit the app's
 * longest honest sentence would have permitted each of them. Measuring the
 * stack is what makes the rule describe a wall rather than a sentence.
 *
 * A block under 8 words is not counted into a passage. That is where a label
 * stops being a label — badges, field names, timestamps and status words all sit
 * well under it, and summing them would make a definition list read as a
 * paragraph. It is a real hole: five seven-word sentences in a row pass. A
 * budget is a budget, not a proof.
 *
 * `Explain` bodies (`[role="tooltip"]`) are lifted OUT of their surrounding
 * block and measured on their own, against the same budget. Both halves of that
 * matter. Lifting them out stops a hidden sentence being charged to the visible
 * paragraph it sits inside. Measuring them at all stops the wall being moved
 * behind an "i" and called a cleanup — `explain.tsx` caps the bubble at 288px
 * and is explicit that it is for one or two sentences.
 *
 * `title`, `aria-label`, `alt` and `placeholder` are measured too, and this is
 * the other dodge worth closing: prose in a `title` is invisible to every
 * assertion in this repository that reads text, and moving a paragraph into one
 * makes it WORSE, not shorter — `title` never appears on touch and is not
 * reachable from a keyboard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ANTI-VACUITY CONTROLS, because the failure mode of a subtraction guard is
 * that it over-subtracts and then passes forever on an empty string.
 *
 *   · Every state names a FLOOR of chrome words it must still see. If the
 *     subtraction ever starts eating the product's own voice, or one of the
 *     state's panels renders empty, the floor fails and this file says so
 *     instead of passing. The numbers are measured — 1231 for a running build,
 *     329 for the smallest single-panel state — and set at roughly three
 *     quarters of that, so removing another quarter of everything the app says
 *     still passes while an over-subtraction, which zeroes most of it at once,
 *     does not.
 *
 *     READ THE NUMBER FOR WHAT IT IS: it is the total over EVERY PANEL OPEN in
 *     that state, and the header and the rail's six tooltips are counted once
 *     per panel. 1231 is not 1231 words on one screen. It is a baseline to
 *     compare against itself, not a word count of the app.
 *
 *     THE FLOOR IS ALSO WHY THE WAIT BEFORE EACH HARVEST CAN BE LENIENT. A
 *     half-drawn panel is not a silent pass here; it is fewer chrome words, and
 *     fewer chrome words is a failure.
 *   · One test asserts the boundary itself in both directions: the harness's
 *     ticket contains the banned word "suite", is genuinely on screen, and is
 *     genuinely absent from the chrome.
 *   · One test proves rule 2 does not fire on legitimately long DATA — a
 *     120-word ticket and a 120-word chat message, both verified to be on screen
 *     at the moment the budget is applied.
 */

import { expect, test, type Page, type Response } from "@playwright/test";

import { ticketLabel } from "@/lib/ticket-title";
import {
  API_ORIGIN,
  BUILD_RUN_ID,
  FINISHED_RUN_ID,
  PLAN_RUN_ID,
  RUN_ID,
} from "./fixtures/config";

/* ------------------------------------------------------------------ */
/* Rule 1: the vocabulary                                              */
/* ------------------------------------------------------------------ */

/**
 * BANNED AS WORDS ON SCREEN, NEVER AS CONCEPTS AND NEVER IN SOURCE.
 *
 * `seat`, `suite`, `digest` and `freeze` are the owner's own list;
 * `verdict`, `env` and `trace` are the three the rail rename deleted and which
 * grew back inside the panels ("Not the design references on the Verdict tab",
 * a card headed TRACE inside the panel headed Activity). Every one of them stays
 * load-bearing in the code, where it is precise — a "seat" really is a
 * structurally separate model call. None of them means anything to the reader.
 *
 * THE PLURALS AND `frozen` ARE IN ON PURPOSE. `\bfreeze\b` does not match
 * "frozen", and "the frozen acceptance suite" was on screen for the whole time
 * the server's copy test said `freeze` was banned. A word list that misses the
 * inflection the copy actually uses measures nothing.
 */
const BANNED =
  /\b(seats?|suites?|digests?|freezes?|freeze|frozen|verdicts?|traces?|env|held-?outs?|sealed|false finish(es)?)\b/i;

/**
 * BANNED WORDS THIS PASS FOUND AND MAY NOT FIX — a debt register, not an
 * amnesty.
 *
 * Every entry below is a string that IS on screen today, DOES carry a banned
 * word, and lives in a file no lane in this pass owned. All five are hover-only
 * `title` attributes and phase blurbs in `outcome.tsx`, `presentation.ts` and
 * `roles.ts`, which fell between the six lanes' file lists. They are subtracted
 * so this guard can land green on the drift it is actually watching for; every
 * one is reported with its file and line.
 *
 * WHEN SOMEBODY FIXES ONE, DELETE ITS ENTRY. A stale entry costs nothing — the
 * substring is simply not found — so nothing here can break a later change. But
 * the list is the record of what is still owed, and a shrinking list is the only
 * evidence that it is temporary.
 */
const PENDING_OTHER_FILES: readonly { readonly where: string; readonly text: string }[] = [
  // EMPTIED 2026-08-18: all six strings were rewritten in plain words
  // (outcome.tsx titles + labels, presentation.ts blurbs). New entries need
  // the same justification the originals carried: file, line, and why the
  // owning lane could not fix it.
];

/* ------------------------------------------------------------------ */
/* Rule 2: the budget                                                  */
/* ------------------------------------------------------------------ */

/**
 * FORTY WORDS, AND HERE IS THE ARITHMETIC RATHER THAN THE VIBE.
 *
 * Two sentences of plain English run about 30 words; 40 is two generous ones.
 * It was set from the three maxima this app renders today, each measured by this
 * file's own harvest before the number was picked:
 *
 *   32 — the longest PASSAGE of visible prose. `notices.tsx`'s false-finish
 *        block: the title sentence plus "Its own account of this run is not
 *        reliable — the criteria below are the evidence, its summary is not."
 *   34 — the longest `Explain` body. `orchestrator-chat.tsx`'s scope rule on the
 *        Chat heading.
 *   36 — the longest `title`. `canvas/roles.ts:94`, the unknown-role tooltip,
 *        and it is the closest thing in the app to the ceiling. It is reported
 *        rather than exempted: at 36 hover-only words it is the next thing that
 *        should be trimmed.
 *
 * WHAT IT CATCHES. The wall the owner screenshotted was 53 words in one
 * paragraph and 50 in the one under it, 103 together in a single `<fieldset>`.
 * Each half fails this budget alone; the pair fails it two and a half times over.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not judge whether a sentence is
 * worth its words — no test can. It buys the one thing a reviewer keeps failing
 * to do by hand: notice that a paragraph has appeared somewhere nobody was
 * looking.
 */
const BUDGET = 40;

/** Below this a block is a label, not prose, and is not summed into a passage. */
const PROSE_MIN = 8;

/* ------------------------------------------------------------------ */
/* Harvesting the rendered text                                        */
/* ------------------------------------------------------------------ */

interface Block {
  /** The rendered text, with any `Explain` body inside it removed. */
  readonly text: string;
  /** Where it is, for a failure message that names the thing. */
  readonly where: string;
  readonly kind: "block" | "explain" | "attr";
  /** Blocks sharing a parent share this; -1 means "measured alone". */
  readonly group: number;
}

/**
 * Every drawn line of text under `rootSelector`, classified.
 *
 * RUNS IN THE PAGE, so it can ask for computed display — which is the whole
 * reason the block rule is written over layout instead of over tag names.
 *
 * THE CANVAS IS SKIPPED (`.react-flow`). Its cards are folded from the server's
 * own event stream and are guarded by `server/src/graph.test.ts`, which owns
 * that vocabulary; scanning them here would double-report the stage labels and
 * charge this file with strings no client lane can reword.
 */
function harvest(rootSelector: string): Block[] {
  const root = document.querySelector(rootSelector);
  if (root === null) return [];

  const out: Block[] = [];
  const groups = new Map<Element, number>();
  const groupOf = (el: Element | null): number => {
    if (el === null) return -1;
    const seen = groups.get(el);
    if (seen !== undefined) return seen;
    const id = groups.size;
    groups.set(el, id);
    return id;
  };

  const isInlineish = (el: Element): boolean => {
    const display = getComputedStyle(el).display;
    return display === "contents" || display.startsWith("inline");
  };

  const tooltips = new Set(Array.from(document.querySelectorAll('[role="tooltip"]')));

  const where = (el: Element): string => {
    const bits: string[] = [];
    let node: Element | null = el;
    while (node !== null && node !== root && bits.length < 4) {
      const id = node.getAttribute("data-testid");
      bits.unshift(id === null ? node.tagName.toLowerCase() : `@${id}`);
      node = node.parentElement;
    }
    return bits.join(">");
  };

  /* An element's own text with any `Explain` body inside it left out: the
     bubble is measured on its own, so charging it here would count it twice. */
  const textWithoutTooltips = (el: Element): string => {
    let text = "";
    const walk = (node: Node): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? "";
        else if (child.nodeType === Node.ELEMENT_NODE) {
          if (tooltips.has(child as Element)) continue;
          walk(child);
        }
      }
    };
    walk(el);
    return text;
  };

  const visit = (el: Element): void => {
    if (el.classList.contains("react-flow")) return;

    for (const name of ["title", "aria-label", "alt", "placeholder"]) {
      const value = el.getAttribute(name);
      if (value !== null && value.trim().length > 0) {
        out.push({ text: value, where: `${where(el)}[${name}]`, kind: "attr", group: -1 });
      }
    }

    if (tooltips.has(el)) {
      out.push({ text: el.textContent ?? "", where: where(el), kind: "explain", group: -1 });
      return;
    }
    if (el instanceof SVGElement) return;
    if (getComputedStyle(el).display === "none") return;

    const kids = Array.from(el.children);
    const blockKids = kids.filter((kid) => !(kid instanceof SVGElement) && !isInlineish(kid));

    if (blockKids.length === 0) {
      const text = textWithoutTooltips(el).replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        out.push({ text, where: where(el), kind: "block", group: groupOf(el.parentElement) });
      }
    }
    for (const kid of kids) visit(kid);
  };

  visit(root);
  return out;
}

/* ------------------------------------------------------------------ */
/* Chrome, separated from data                                         */
/* ------------------------------------------------------------------ */

/** Every string anywhere in a JSON body, however deeply nested. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, into);
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) stringsIn(item, into);
  }
  return into;
}

/**
 * Record everything the API says to this page, for as long as the page lives.
 *
 * LISTENING RATHER THAN FETCHING A KNOWN LIST OF ENDPOINTS is the difference
 * between a boundary that stays correct and one that rots. The code viewer
 * fetches `?path=` per file and the plan panel fetches `/messages`; a hard-coded
 * list would have missed both, and a missed endpoint does not fail loudly — it
 * quietly reports the owner's own file contents as the product's prose.
 */
function recordSupplied(page: Page): () => Promise<readonly string[]> {
  const pending: Promise<void>[] = [];
  const supplied: string[] = [];
  page.on("response", (response: Response) => {
    if (!response.url().startsWith(API_ORIGIN)) return;
    pending.push(
      (async (): Promise<void> => {
        try {
          if (!(response.headers()["content-type"] ?? "").includes("json")) return;
          const body = (await response.json()) as unknown;
          supplied.push(...stringsIn(body));
          const detail = body as { ticketTitle?: unknown; ticketText?: unknown };
          if (typeof detail.ticketTitle === "string") {
            supplied.push(ticketLabel(detail.ticketTitle));
          }
          if (typeof detail.ticketText === "string") {
            supplied.push(ticketLabel(detail.ticketText));
          }
        } catch {
          /* a stream, or a body the browser never kept. Not data we can use. */
        }
      })(),
    );
  });
  return async (): Promise<readonly string[]> => {
    await Promise.all(pending);
    return supplied;
  };
}

/**
 * One rendered string with everything the run supplied taken out of it.
 *
 * Cut strings are replaced with a SPACE rather than with nothing: deleting a run
 * of characters can butt two fragments together and manufacture a word neither
 * of them contained, which would be a failure this file invented rather than
 * found.
 */
function chromeOf(rendered: string, supplied: readonly string[]): string {
  const flat = rendered.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";

  /* Wholly-supplied text is data outright — see the header on `PQ-3`. */
  for (const item of supplied) {
    const norm = item.replace(/\s+/g, " ").trim();
    if (norm.length >= 12 && norm.includes(flat)) return "";
  }

  let chrome = flat;
  for (const item of [...supplied].sort((a, b) => b.length - a.length)) {
    const norm = item.replace(/\s+/g, " ").trim();
    if (norm.length === 0) continue;
    if (norm.length < 12 && !BANNED.test(norm)) continue;
    chrome = chrome.split(norm).join(" ");
  }
  for (const pending of PENDING_OTHER_FILES) {
    chrome = chrome.split(pending.text).join(" ");
  }
  return chrome;
}

/** Words, counting only tokens with a letter in them. */
function words(text: string): number {
  return text.split(/\s+/).filter((token) => /[A-Za-z]/.test(token)).length;
}

/** The sentence a banned word sits in, so a failure names the string. */
function sentenceAround(text: string, index: number): string {
  const from = Math.max(0, text.lastIndexOf(".", index) + 1);
  const to = text.indexOf(".", index);
  return text.slice(from, to === -1 ? index + 140 : to + 1).trim();
}

/* ------------------------------------------------------------------ */
/* Driving the rail                                                    */
/* ------------------------------------------------------------------ */

/**
 * Open a panel BY KEYBOARD, for the harness reason `rail.browser.spec.ts`
 * records: `next dev` pins a `<nextjs-portal>` badge to the bottom-left of the
 * viewport, exactly where the rail pins its last entry, and Playwright refuses a
 * pointer click it would intercept.
 *
 * ENTER IS A TOGGLE, so it is only pressed on a panel that is not already open.
 * Overview opens by default and Questions opens by itself on a parked run.
 */
async function openPanel(page: Page, entry: string): Promise<void> {
  const button = page.getByTestId(`rail-${entry}`);
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("rail-panel")).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

/**
 * Wait for a panel's own fetches to land before reading it.
 *
 * BOUNDED AND SWALLOWED ON PURPOSE. A live run holds an SSE connection open for
 * as long as the page is up, so "no network for 500ms" is not something this app
 * can be relied on to reach; treating a timeout here as a failure would make
 * this file flake on the one state it most needs to read. It is safe to give up
 * waiting because a premature read is not a silent pass — the harvest would
 * return a half-drawn panel and the state's chrome-word floor is what fails.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

type Patch = Record<string, unknown>;

/**
 * Serve one run's detail with fields changed, and hand back the strings the
 * patch introduced so they are treated as data like any other served string.
 *
 * THE HEADERS ARE WRITTEN OUT RATHER THAN COPIED, and both shortcuts were tried
 * and watched fail in the same way — `panel-copy.browser.spec.ts` records the
 * diagnosis at length: neither `route.fulfill({ response })` nor a copy of
 * `response.headers()` produces a page, because the first carries the original
 * `content-length` over a body of a different length and the second restates
 * hop-by-hop headers. The run view then mounts with `run === null`, the rail is
 * absent, and the failure reads as "the toolbar was never rendered".
 * `access-control-allow-origin` is not optional: the app is on 4322 and the
 * fixture API on 4177.
 *
 * THE BODY IS FETCHED ONCE, BEFORE THE ROUTE IS INSTALLED — ported verbatim in
 * shape from `canvas-shell-copy.browser.spec.ts`, which landed this repair for
 * three flakes of its own and was the only one of four files to get it.
 * `await route.fetch()` INSIDE the handler put a second round trip in front of
 * every detail response, and the run page raced that delay against its own SSE
 * replay. The product no longer loses that race
 * (`lib/use-run-stream.ts` — the stream refuses to fold into an empty cache, and
 * `blank-cache.browser.spec.ts` deliberately loses the race to prove it), so
 * this is no longer the difference between a page and a blank one. It is still
 * a round trip this harness has no reason to add, and leaving three files on the
 * old shape would leave three files whose timing differs from the fourth's for
 * no stated reason.
 */
async function patchDetail(page: Page, runId: string, patch: Patch): Promise<string[]> {
  const introduced: string[] = [];
  for (const value of Object.values(patch)) stringsIn(value, introduced);

  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${runId}`);
  const body = (await seed.json()) as Record<string, unknown>;
  Object.assign(body, patch);
  const payload = JSON.stringify(body);

  await page.route(
    (url) => url.pathname === `/api/runs/${runId}` && url.search === "",
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: payload,
      });
    },
  );
  return introduced;
}

/* ------------------------------------------------------------------ */
/* What gets swept                                                     */
/* ------------------------------------------------------------------ */

/**
 * THE ROOT IS THE WHOLE RUN VIEW, NOT THE RAIL PANEL, and that is a deliberate
 * widening of the brief. `RateLimitNotice` and `AwaitingInputNotice` — two of
 * the wordiest blocks in the app before this pass — FLOAT over the canvas rather
 * than sitting in a panel (`runs/[runId]/page.tsx:820-866`), so a scan rooted at
 * `[data-testid="rail-panel"]` never sees them. Rooting at `body` costs seven
 * extra chrome words per state (the header) and buys both notices.
 */
const ROOT = "body";

/**
 * Every state this file opens, with the floor of chrome words it must still see.
 *
 * THE FLOORS ARE THE ANTI-VACUITY CONTROL and they are measured, at roughly half
 * of what each state renders today. Too high and a legitimate trim nags; too low
 * and an over-eager subtraction passes forever on nothing. They are per state
 * rather than one global number because a single global floor stays satisfied
 * while four of the six panels render empty.
 *
 * THE PATCHED STATES ARE NOT DECORATION. Six of this app's wordiest blocks —
 * both rate-limit branches, the stopped-waiting notice, the false finish, the
 * never-graded sentence and the refused copy — render on no fixture run, so
 * before these entries existed no browser check in this repository had ever read
 * them.
 */
const SWEEP: readonly {
  readonly name: string;
  readonly run: string;
  readonly entries: readonly string[];
  readonly floor: number;
  readonly patch?: Patch;
}[] = [
  {
    name: "a running build",
    run: RUN_ID,
    entries: ["overview", "chat", "files", "result", "activity"],
    floor: 900,
  },
  {
    name: "a run that finished and failed",
    run: FINISHED_RUN_ID,
    entries: ["overview", "result", "activity", "files", "chat"],
    floor: 1050,
  },
  {
    name: "a live build with a workspace",
    run: BUILD_RUN_ID,
    entries: ["overview", "result", "activity"],
    floor: 620,
  },
  {
    name: "a run parked on its questions",
    run: PLAN_RUN_ID,
    entries: ["questions", "chat", "overview", "result"],
    floor: 900,
  },
  {
    name: "rate limited, with a window to wait out",
    run: RUN_ID,
    entries: ["result"],
    floor: 220,
    patch: { status: "rate_limited", rateLimit: { limited: true, retryAfterSec: 900 } },
  },
  {
    name: "rate limited, with no window reported",
    run: RUN_ID,
    entries: ["result"],
    floor: 220,
    patch: { status: "rate_limited", rateLimit: { limited: true, retryAfterSec: null } },
  },
  {
    name: "stopped, waiting on the owner",
    run: RUN_ID,
    entries: ["result"],
    floor: 220,
    patch: { status: "awaiting_input" },
  },
  {
    name: "a false finish",
    run: FINISHED_RUN_ID,
    entries: ["result"],
    floor: 270,
    patch: { falseFinish: true },
  },
  {
    name: "a run that passed",
    run: FINISHED_RUN_ID,
    entries: ["result"],
    floor: 270,
    patch: { status: "passed", heldOutPass: true, falseFinish: false },
  },
  {
    name: "a run that was never graded",
    run: FINISHED_RUN_ID,
    entries: ["result"],
    floor: 270,
    patch: { heldOutPass: null },
  },
  {
    name: "a run the owner cancelled",
    run: FINISHED_RUN_ID,
    entries: ["result"],
    floor: 250,
    patch: { status: "cancelled" },
  },
  {
    name: "a copy of the work that was refused",
    run: FINISHED_RUN_ID,
    entries: ["result"],
    floor: 240,
    patch: {
      publishedProject: {
        published: false,
        reason: "workspace-empty",
        detail: "the workspace at /tmp/harness/workspace holds no publishable file",
        attemptedAt: "2026-08-04T12:00:00.000Z",
      },
    },
  },
  {
    name: "a copy of the work that was made",
    run: FINISHED_RUN_ID,
    entries: ["result"],
    floor: 240,
    patch: {
      publishedProject: {
        published: true,
        path: "/tmp/harness/projects/coglane",
        publishedAt: "2026-08-04T12:00:00.000Z",
        fileCount: 12,
        bytes: 48_000,
        excluded: [],
      },
    },
  },
];

interface Scored extends Block {
  readonly chrome: string;
  readonly count: number;
}

/** Open every panel of one state and score every block in each. */
async function sweep(
  page: Page,
  state: (typeof SWEEP)[number],
): Promise<{ readonly rows: Scored[]; readonly chromeWords: number }> {
  const settle = recordSupplied(page);
  const introduced = state.patch === undefined ? [] : await patchDetail(page, state.run, state.patch);

  await page.goto(`/runs/${state.run}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();

  const rows: Scored[] = [];
  let base = 0;
  for (const entry of state.entries) {
    await openPanel(page, entry);
    /* The panels fetch on mount — the tree, a file's contents, the transcript —
       so the harvest waits for the network to go quiet before it reads, and the
       recorder is settled AFTER the harvest so those bodies are in `supplied`. */
    await settled(page);
    const blocks = await page.evaluate(harvest, ROOT);
    const supplied = [...(await settle()), ...introduced];
    for (const block of blocks) {
      const chrome = chromeOf(block.text, supplied);
      /* GROUP IDS RESTART AT 0 IN EVERY HARVEST, so without this offset the
         first paragraph of the Files panel and the first of the Result panel
         would be added together as one passage — a wall this file invented
         rather than found. */
      const group = block.group < 0 ? -1 : block.group + base;
      rows.push({ ...block, group, chrome, count: words(chrome) });
    }
    base += 100_000;
  }
  return { rows, chromeWords: rows.reduce((sum, row) => sum + row.count, 0) };
}

/** Every passage: prose blocks sharing a parent, added up. */
function passages(rows: readonly Scored[]): { where: string; text: string; count: number }[] {
  const byGroup = new Map<number, Scored[]>();
  for (const row of rows) {
    if (row.kind !== "block" || row.count < PROSE_MIN) continue;
    byGroup.set(row.group, [...(byGroup.get(row.group) ?? []), row]);
  }
  return [...byGroup.values()].map((group) => ({
    where: group[0]?.where ?? "",
    text: group.map((row) => row.chrome).join(" ⏎ "),
    count: group.reduce((sum, row) => sum + row.count, 0),
  }));
}

/* ------------------------------------------------------------------ */
/* RULE 1 — no banned word in anything the product writes              */
/* ------------------------------------------------------------------ */

test.describe("no panel speaks the vocabulary the owner rejected", () => {
  for (const state of SWEEP) {
    test(state.name, async ({ page }) => {
      const { rows, chromeWords } = await sweep(page, state);

      expect(
        chromeWords,
        `${state.name}: only ${String(chromeWords)} words of this product's own copy were found, ` +
          `so either a panel rendered empty or the subtraction is eating chrome. This scan proves nothing.`,
      ).toBeGreaterThanOrEqual(state.floor);

      const offences = rows
        .map((row) => {
          const hit = BANNED.exec(row.chrome);
          return hit === null
            ? null
            : `${row.where} prints "${hit[0]}" — ${sentenceAround(row.chrome, hit.index)}`;
        })
        .filter((offence): offence is string => offence !== null);

      expect(offences, `${state.name}: jargon in copy this product wrote`).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------ */
/* RULE 2 — no wall of prose                                           */
/* ------------------------------------------------------------------ */

test.describe("no panel carries a wall of prose", () => {
  for (const state of SWEEP) {
    test(state.name, async ({ page }) => {
      const { rows, chromeWords } = await sweep(page, state);

      expect(
        chromeWords,
        `${state.name}: only ${String(chromeWords)} words of chrome were found, so this budget measured nothing`,
      ).toBeGreaterThanOrEqual(state.floor);

      const over = [
        ...passages(rows).map((passage) => ({
          what: `the passage at ${passage.where}`,
          count: passage.count,
          text: passage.text,
        })),
        ...rows
          .filter((row) => row.kind !== "block")
          .map((row) => ({
            what: row.kind === "explain" ? `the Explain body ${row.where}` : `the ${row.where}`,
            count: row.count,
            text: row.chrome,
          })),
      ]
        .filter((item) => item.count > BUDGET)
        .map((item) => `${item.what} is ${String(item.count)} words (budget ${String(BUDGET)}): ${item.text}`);

      expect(over, `${state.name}: explanatory prose over budget`).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------ */
/* The boundary itself, asserted in both directions                    */
/* ------------------------------------------------------------------ */

/**
 * THE CONTROL THAT KEEPS THIS FILE HONEST, and the harness happens to hand it
 * over for free: the fixture's ticket is titled "Give the client a test suite"
 * and reads "Add a test suite to the dashboard client."
 *
 * So a banned word IS on the Overview panel, put there by the owner, and rule 1
 * is green. Both halves are asserted, because either one alone is satisfiable by
 * a bug: assert only the absence and an over-eager subtraction passes; assert
 * only the presence and a guard that scans nothing passes.
 */
test("the owner's own ticket may say 'suite', and the guard does not fire on it", async ({
  page,
}) => {
  const settle = recordSupplied(page);
  await page.goto(`/runs/${RUN_ID}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
  await openPanel(page, "overview");
  await settled(page);

  const rendered = await page.getByTestId("overview-ticket").textContent();
  expect(rendered ?? "", "the harness ticket no longer contains a banned word").toMatch(
    /test suite/i,
  );

  const supplied = await settle();
  const chrome = chromeOf(rendered ?? "", supplied);
  expect(BANNED.test(chrome), `the ticket's own words survived into the chrome: ${chrome}`).toBe(
    false,
  );

  /* And the panel is not scanned down to nothing on the way: the ticket block
     also carries the product's own subtitle, which must survive. */
  const state = SWEEP[0] as (typeof SWEEP)[number];
  const { chromeWords } = await sweep(page, state);
  expect(chromeWords).toBeGreaterThanOrEqual(state.floor);
});

/**
 * RULE 2 MUST NOT FIRE ON DATA, and this is the control that proves the
 * chrome/data boundary is doing the work rather than the budget being generous.
 *
 * A 120-word ticket and a 120-word chat message are served — three times the
 * budget each — and both are asserted to be ON SCREEN at the moment the budget
 * is applied. Without that assertion the test would pass just as well if the
 * long text never rendered, which is the shape of vacuous check this repository
 * keeps producing.
 */
const LONG_TICKET = `${"Rebuild the marketing site so that every section reads as one piece of work rather than six. ".repeat(6)}`;
const LONG_MESSAGE = `${"Please make the hero image sit above the fold on a laptop and keep the type at the size it is now. ".repeat(5)}`;

test("a long ticket and a long chat message are data, and the budget leaves them alone", async ({
  page,
}) => {
  const settle = recordSupplied(page);
  await patchDetail(page, PLAN_RUN_ID, { ticketText: LONG_TICKET });
  /*
   * SAME PRE-FETCH AS `patchDetail`, AND FOR A WEAKER REASON — said so rather
   * than implied. `/messages` is not on the blank-page race path: nothing folds
   * it into the SWR run cache, so a round trip in front of it delays a chat
   * pane and blanks nothing. It is ported anyway so that every route this file
   * installs has the same timing, which is what makes "the harness added a
   * delay" a hypothesis this suite can rule out in one glance instead of four.
   */
  const messageSeed = await page.request.get(
    `${API_ORIGIN}/api/runs/${PLAN_RUN_ID}/messages`,
  );
  const seeded = (await messageSeed.json()) as { messages?: unknown[] };
  const messagePayload = JSON.stringify({
    messages: [
      ...(seeded.messages ?? []),
      {
        seq: 900,
        at: "2026-08-04T12:00:00.000Z",
        role: "owner",
        text: LONG_MESSAGE,
        images: [],
        deliveredAt: "2026-08-04T12:00:01.000Z",
      },
    ],
  });

  await page.route(
    (url) => url.pathname === `/api/runs/${PLAN_RUN_ID}/messages`,
    async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: messagePayload,
      });
    },
  );

  await page.goto(`/runs/${PLAN_RUN_ID}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();

  /* One panel at a time, harvested as it is open: the rail shows one panel, so
     the ticket and the transcript are never on screen together. */
  const blocks: Block[] = [];
  await openPanel(page, "overview");
  await settled(page);
  await expect(page.getByTestId("overview-ticket")).toContainText(
    "every section reads as one piece of work rather than six",
  );
  blocks.push(...(await page.evaluate(harvest, ROOT)));
  const chatFrom = blocks.length;

  await openPanel(page, "chat");
  await settled(page);
  await expect(page.getByTestId("rail-panel")).toContainText(
    "keep the type at the size it is now",
  );
  blocks.push(...(await page.evaluate(harvest, ROOT)));

  const supplied = await settle();
  const rows: Scored[] = blocks.map((block, index) => {
    const chrome = chromeOf(block.text, supplied);
    /* Same offset as `sweep`: two harvests, two independent group numberings. */
    const group = block.group < 0 ? -1 : block.group + (index < chatFrom ? 0 : 100_000);
    return { ...block, group, chrome, count: words(chrome) };
  });

  /* The two long strings really are among the blocks that were measured — so
     "green" here means "measured and forgiven", not "never looked at". */
  const raw = rows.map((row) => row.text).join(" ");
  expect(raw).toContain("every section reads as one piece of work rather than six");
  expect(raw).toContain("keep the type at the size it is now");

  const over = [...passages(rows), ...rows.filter((row) => row.kind !== "block")]
    .filter((item) => item.count > BUDGET)
    .map((item) => `${String(item.count)} words: ${"chrome" in item ? item.chrome : item.text}`);
  expect(over, "the owner's own long text was charged to the product's budget").toEqual([]);
});
