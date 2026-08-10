/**
 * THE WORDS INSIDE THE PANELS — the half the rail rename never covered.
 *
 * WHAT WENT WRONG, PLAINLY. `rail.browser.spec.ts` renamed the six rail entries
 * into plain English and guards them; `server/src/graph.test.ts` guards the stage
 * cards. Between them they cover LABELS and HEADINGS and nothing else, so the
 * BODIES kept the vocabulary the owner rejected — "Not the design references on
 * the Verdict tab" (a tab deleted the day before), "Whether a seat was given the
 * text is the run's trace to answer", a card headed TRACE inside the panel headed
 * Activity. Every one of those was on screen, and every existing check was green.
 *
 * THE OWNER'S RULE, VERBATIM: "spec seat audit seat freeze. These dont really mean
 * anything to me. For example PLan means something, orchestrator means something,
 * ui agent etc" and "I want it userfriendly and simple interms of no jargon".
 *
 * WHERE THE LINE IS DRAWN, AND WHY IT HAS TO BE DRAWN SOMEWHERE. A whole-page scan
 * for these words CANNOT WORK: the harness's own ticket reads "Add a test suite to
 * the dashboard client", the failure cause the server writes reads "the spec seat
 * … call failed", and a chat message is whatever the owner typed. A guard that
 * reddens on the owner's own prose is a guard somebody deletes within a week, and
 * then the real drift comes back with it.
 *
 * So this file scans THE CHROME — the strings this product writes about itself —
 * and it separates chrome from content MECHANICALLY rather than by picking
 * selectors:
 *
 *   1. every panel's rendered text is read with `innerText`;
 *   2. every string the API served for that run (the run detail, the graph
 *      snapshot, the workspace tree, the messages) is subtracted from it, plus
 *      `ticketLabel`'s derived heading, which is a CUT of the owner's own words
 *      and therefore his too;
 *   3. what is left is text no run supplied — the product's own voice — and that
 *      is what the banned list is applied to.
 *
 * THE SUBTRACTION IS EXACT-SUBSTRING, which is a real limit and is named rather
 * than hidden: a TRUNCATED rendering of supplied text (`MonoPath`'s ellipsis) is
 * not matched by the whole string it was cut from. No fixture path contains a
 * banned word today. If one ever does, subtract it here — do not delete the check.
 *
 * AND THE SUBTRACTION CANNOT SWALLOW THE CHECK, which is the failure mode this
 * design would otherwise have: over-subtract and every panel scans clean forever.
 * Each panel therefore names a CANARY — a chrome sentence that must SURVIVE the
 * subtraction. If the canary is gone, the scan is not reading the panel and this
 * file says so instead of passing.
 *
 * MUTATIONS, ALL APPLIED TO PRODUCTION CODE, WATCHED RED, REVERTED — see each test.
 */

import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

import { ticketLabel } from "@/lib/ticket-title";
import { API_ORIGIN, FINISHED_RUN_ID, PLAN_RUN_ID, RUN_ID } from "./fixtures/config";

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

/**
 * BANNED AS WORDS, NEVER AS CONCEPTS.
 *
 * `seat`, `digest`, `suite` and `freeze` are the server copy test's list
 * (`server/src/graph.test.ts`, "COPY: no seat jargon reaches a string the owner
 * reads") repeated over the client strings that test cannot see; `verdict`,
 * `trace` and `env` are the three the rail rename deleted. Nothing here weakens
 * that test — it is not touched, and this file only adds surface.
 *
 * THE PLURALS AND `frozen` ARE IN ON PURPOSE. `\bfreeze\b` does not match
 * "frozen", and "the frozen acceptance suite" was on screen the whole time the
 * server's list said `freeze` was banned. A word list that misses the inflection
 * the copy actually uses is a list that measures nothing.
 */
const BANNED =
  /\b(seats?|suites?|digests?|freezes?|freeze|frozen|verdicts?|traces?|env)\b/i;

/**
 * COPY OWNED BY LANES THIS PASS MAY NOT TOUCH — a hand-off, not an amnesty.
 *
 * Each entry is a string that IS on screen in a rail panel today and DOES carry a
 * banned word, in a file outside this lane's list. They are subtracted so this
 * file can land green on the copy it actually owns; every one is reported in the
 * hand-off with its file and line.
 *
 * WHEN A LANE FIXES ONE, DELETE ITS ENTRY. Leaving a stale entry costs nothing
 * (the substring simply is not found), so nothing here can break a sibling's
 * change — but the list is the record of what is still owed, and a shrinking list
 * is the only evidence this is temporary.
 */
const PENDING_OTHER_LANES: readonly { readonly where: string; readonly text: string }[] = [
  {
    where: "src/components/canvas/orchestrator-chat.tsx:729 — the composer's footnote",
    text: "The acceptance suite is frozen, so ask for changes it is indifferent to",
  },
  {
    where: "src/components/run/design-directions.tsx:147 — FROZEN_SUITE_SENTENCE, mirrored in the server's run log",
    text: "The acceptance suite was frozen in the spec phase.",
  },
  {
    where: "src/components/run/motion.tsx:300 — the motion read-out's closing sentence",
    text: "is the run’s verdict to answer",
  },
];

/* ------------------------------------------------------------------ */
/* Chrome, separated from content                                      */
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
 * Everything this run SUPPLIED, straight off the fixture API.
 *
 * The four bodies are the four sources of text a panel renders that this product
 * did not write: the run detail (ticket, criteria statements, failure cause,
 * paths), the graph snapshot (agent names, the machine inventory), the workspace
 * tree (file and directory names) and the messages (both sides of the chat).
 *
 * `ticketLabel` IS ADDED BECAUSE IT IS NOT SERVED — Overview's heading is a CUT of
 * `ticketTitle` made in the browser, so subtracting the whole title leaves the cut
 * on screen. It is still the owner's words with some of them removed, and a check
 * that fires on it is a check that fires on his ticket.
 *
 * ONLY LONG STRINGS ARE SUBTRACTED WHOLESALE, AND THAT THRESHOLD WAS MEASURED
 * RATHER THAN CHOSEN. The first version subtracted every served string of three
 * characters or more, and the fixture serves `"running"`, `"pass"` and
 * `"builder"` as field values — so the composer's own sentence came back as
 * "While a segment is   this goes into the open session" and the criteria
 * subtitle as "the   could not edit them". Cutting single words out of the
 * product's prose is how this check would quietly stop reading it.
 *
 * A SHORT SERVED STRING IS SUBTRACTED ONLY IF IT IS ITSELF A BANNED WORD — a file
 * named `suite.ts`, an inventory value of `env`. That is exactly the case the
 * exemption exists for, and nothing wider.
 */
async function suppliedText(api: APIRequestContext, runId: string): Promise<string[]> {
  const base = `${API_ORIGIN}/api/runs/${encodeURIComponent(runId)}`;
  const bodies: unknown[] = [];
  for (const url of [base, `${base}/graph`, `${base}/files`, `${base}/messages`]) {
    const response = await api.get(url);
    if (!response.ok()) continue;
    bodies.push((await response.json()) as unknown);
  }
  expect(bodies.length, `the fixture API served nothing for ${runId}`).toBeGreaterThan(0);

  const supplied = bodies.flatMap((body) => stringsIn(body));
  const detail = bodies[0] as { ticketTitle?: string; ticketText?: string };
  if (typeof detail.ticketTitle === "string") supplied.push(ticketLabel(detail.ticketTitle));
  if (typeof detail.ticketText === "string") supplied.push(ticketLabel(detail.ticketText));

  return supplied.filter((text) => text.trim().length >= 20 || BANNED.test(text));
}

/**
 * QUOTE MARKS FLATTENED TO ASCII — the one difference this file does not read.
 *
 * `code-browser.tsx:343` writes its subtitle with `&rsquo;`, so the Files panel
 * renders "The run’s workspace, read-only." while this file's canary was typed
 * with an ASCII apostrophe. That difference reddened the anti-vacuity check on a
 * sentence that WAS on screen, word for word — the check reported "the panel's
 * own copy is not in the scanned text" about copy that was in it.
 *
 * ONLY THE QUOTE CLASS IS TOUCHED, AND THE LIMIT IS THE POINT. Case is left
 * alone because case is exactly what the Overview canary caught on 2026-08-05 —
 * a closed `Explain` body inheriting `uppercase` from its heading and handing a
 * screen reader a sentence in capitals — and a case-insensitive compare here
 * would have hidden it. Dashes are left alone because they are load-bearing in
 * this copy ("queued — not read yet"). Whitespace is left alone because the
 * subtraction below depends on it.
 *
 * APPLIED TO BOTH SIDES, never to the rendered text alone: the served ticket
 * text is the owner's own typing and may carry a curly apostrophe of its own, so
 * normalising only one side would stop that string subtracting and leave the
 * owner's words in the scan.
 */
function plainQuotes(text: string): string {
  return text.replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"');
}

/**
 * The panel's text with everything the run supplied taken out of it.
 *
 * Replaced with a SPACE and not with nothing: deleting a run of characters can
 * butt two fragments together and manufacture a word neither of them contained,
 * which would be a failure this file invented rather than found.
 */
function chromeOf(rendered: string, supplied: readonly string[]): string {
  let chrome = plainQuotes(rendered);
  for (const text of supplied.map(plainQuotes).sort((a, b) => b.length - a.length)) {
    chrome = chrome.split(text).join(" ");
  }
  for (const pending of PENDING_OTHER_LANES) {
    chrome = chrome.split(plainQuotes(pending.text)).join(" ");
  }
  return chrome;
}

/* ------------------------------------------------------------------ */
/* Driving the rail                                                    */
/* ------------------------------------------------------------------ */

/**
 * Open a panel BY KEYBOARD, for the harness reason `rail.browser.spec.ts` records:
 * `next dev` pins a `<nextjs-portal>` dev-tools badge to the bottom-left of the
 * viewport, exactly where an activity-bar rail pins its last entry, and Playwright
 * refuses a pointer click it would intercept. Every rail entry has to be operable
 * from the keyboard anyway.
 */
async function openPanel(page: Page, entry: string): Promise<void> {
  const button = page.getByTestId(`rail-${entry}`);
  /*
   * ENTER IS A TOGGLE, so pressing it on a panel that is ALREADY open closes it.
   * Two entries open by themselves — Overview is the default, and Questions
   * auto-opens on a parked run, which is the owner's un-stick control — and the
   * first version of this helper closed both and then waited 15s for a panel it
   * had just shut.
   */
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("rail-panel")).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

async function openRun(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("toolbar", { name: "Run panels" })).toBeVisible();
}

/**
 * One panel, on one run, with the chrome sentence that proves it was read.
 *
 * THE CANARY IS THE ANTI-VACUITY CONTROL and it is per-panel on purpose: a single
 * global one would still pass while four of the six panels rendered nothing at
 * all. Each string below is written by this product, is not in any fixture, and
 * belongs to the panel it is filed under.
 */
const SWEEP: readonly {
  readonly run: string;
  readonly entry: string;
  readonly canary: string;
}[] = [
  {
    run: RUN_ID,
    entry: "overview",
    canary: "picking one here selects its card on the canvas",
  },
  {
    run: RUN_ID,
    /*
     * THE CHAT CANARY WAS REPLACED, NOT WEAKENED — 2026-08-05.
     *
     * The old one, "While a segment is running this goes into the open session",
     * was DELETED from production by the copy pass: `orchestrator-chat.tsx:896`
     * records it going, along with "there is no session to push into" and "it is
     * queued and folded into the next prompt", because the OUTCOME each of them
     * described is already printed under every message as `queued — not read
     * yet` or `read at 14:02`.
     *
     * ITS REPLACEMENT IS THE HALF OF THAT PARAGRAPH THAT SURVIVED, moved onto the
     * send button as `explain-timing` (`orchestrator-chat.tsx:826`). It qualifies
     * on all three counts this list requires: it is a sentence THIS PRODUCT
     * writes, it appears in no fixture body (so the subtraction cannot supply
     * it), and it is rendered only by the composer — a Chat panel that drew
     * nothing, or drew a message list with no composer under it, would not carry
     * it, which is the vacuity this canary exists to catch.
     *
     * WHY NOT THE OTHER CANDIDATE. `explain-scope`, on the Chat heading, is the
     * longer sentence and was the obvious pick — but it sits inside the
     * `uppercase` `<h4>` at :373, which is the same construction that put the
     * Overview canary in capitals. Hanging this repair off that one would make
     * two independent panels fail together.
     */
    entry: "chat",
    canary: "While the run is working it reads this at its next step.",
  },
  {
    run: RUN_ID,
    entry: "files",
    /*
     * TYPED WITH AN ASCII APOSTROPHE AND MATCHED AGAINST ONE — see
     * `plainQuotes`. The panel renders `&rsquo;` here; the sentence is otherwise
     * unchanged and is still asserted whole.
     */
    canary: "The run's workspace, read-only.",
  },
  {
    run: RUN_ID,
    entry: "result",
    canary: "Written from your ticket before any code existed",
  },
  {
    run: RUN_ID,
    entry: "activity",
    canary: "Waiting for the first event.",
  },
  {
    // The failed run: the outcome notice and the server's own cause string.
    run: FINISHED_RUN_ID,
    entry: "result",
    canary: "the work did not pass the acceptance tests",
  },
  {
    /*
     * The parked run: the Questions panel, which exists on no other fixture.
     *
     * ITS CANARY IS A SENTENCE `plan-dialogue.tsx` WRITES, not one of the
     * fixture's `PQ-n` questions. The questions are the run's own words and are
     * subtracted, so using one would have proved only that the subtraction was
     * incomplete.
     */
    run: PLAN_RUN_ID,
    entry: "questions",
    canary: "is read as part of this exchange",
  },
];

test.describe("no rail panel body speaks the vocabulary the owner rejected", () => {
  for (const { run, entry, canary } of SWEEP) {
    test(`${entry} on ${run}`, async ({ page, request }) => {
      const supplied = await suppliedText(request, run);
      await openRun(page, run);
      await openPanel(page, entry);

      const rendered = await page.getByTestId("rail-panel").innerText();
      const chrome = chromeOf(rendered, supplied);

      /*
       * THE SCAN IS PROVED TO BE LOOKING AT SOMETHING FIRST. Without this, an
       * over-eager subtraction — or a panel that silently rendered empty —
       * produces a green run that measured nothing, which is this repository's
       * signature defect in a new costume.
       */
      expect(
        chrome,
        `the ${entry} panel's own copy is not in the scanned text, so this scan proves nothing`,
      ).toContain(canary);

      /*
       * MUTATIONS APPLIED, ONE PER PANEL THIS LANE OWNS, EACH WATCHED RED AND
       * REVERTED — the full list is in the hand-off. The shortest of them:
       * `title="Activity"` back to `title="Trace"` in `run/trace.tsx`, which
       * reddens the activity row below with `TRACE`.
       */
      const hit = BANNED.exec(chrome);
      expect(
        hit === null ? null : sentenceAround(chrome, hit.index),
        `the ${entry} panel prints "${hit?.[0] ?? ""}" in copy this product wrote`,
      ).toBeNull();
    });
  }
});

/** The offending sentence, so a failure names the string instead of the word. */
function sentenceAround(text: string, index: number): string {
  const from = Math.max(0, text.lastIndexOf(".", index) + 1);
  const to = text.indexOf(".", index);
  return text.slice(from, to === -1 ? index + 120 : to + 1).trim();
}

/* ------------------------------------------------------------------ */
/* The two facts the rewrite had to keep                               */
/* ------------------------------------------------------------------ */

/**
 * A run detail with attachments on it, which NO FIXTURE HAS.
 *
 * `run-fixture.ts` serves `references: []` and `documents: []` on every run, so
 * `TicketAttachmentsPanel` returns `null` in the harness and its copy has never
 * been in front of a browser check — which is most of why the "Verdict tab"
 * sentence survived a rename that deleted the Verdict tab. The fixture file is
 * another lane's this pass and four specs measure `RUN_ID` for pixels, so the two
 * attachments are injected HERE, in the spec that needs them, and no other test
 * sees a changed run.
 *
 * The bytes behind these files do not exist, so both rows fail over to the named
 * row `AttachmentImage` degrades to. That is the point of the panel's subtitle
 * either way: the sentence under test is the panel's, not a thumbnail's.
 */
/**
 * Serve one run's detail with fields changed.
 *
 * THE HEADERS ARE WRITTEN OUT, NOT COPIED, AND BOTH SHORTCUTS WERE TRIED AND
 * WATCHED FAIL — in the same way, which is why it is worth the paragraph. Neither
 * `route.fulfill({ response, json })` nor a copy of `response.headers()` produces
 * a page: the run view mounts with `run === null` and renders the bare
 * `<Panel title="Run">` skeleton, so the RAIL IS SIMPLY ABSENT and the failure
 * reads as "the toolbar was never rendered" rather than as anything about a
 * response. The first carries the original `content-length` over a body of a
 * different length; the second carries `connection` and `keep-alive`, which are
 * hop-by-hop headers a fulfilled response may not restate.
 *
 * `access-control-allow-origin` is not optional here: the app is served from
 * 4322 and the fixture API from 4177, so a fulfilled response without it is a
 * CORS failure and the same blank page.
 *
 * AND THE BODY IS FETCHED ONCE, BEFORE THE ROUTE IS INSTALLED — the last of the
 * four files to receive the repair `canvas-shell-copy.browser.spec.ts` landed
 * on 2026-08-05. `await route.fetch()` inside the handler added a round trip of
 * the harness's own to every detail response, and the run page raced that delay
 * against its own SSE replay; a stream that won used to write over the SWR cache
 * and the page never recovered. That product race is closed in
 * `lib/use-run-stream.ts` and is deliberately lost on purpose in
 * `blank-cache.browser.spec.ts`, so what this removes now is an unexplained
 * timing difference between this file and its siblings, not a failure.
 */
async function patchDetail(
  page: Page,
  runId: string,
  patch: (body: Record<string, unknown>) => void,
): Promise<void> {
  const seed = await page.request.get(`${API_ORIGIN}/api/runs/${runId}`);
  const body = (await seed.json()) as Record<string, unknown>;
  patch(body);
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
}

async function withAttachments(page: Page): Promise<void> {
  await patchDetail(page, RUN_ID, (body) => {
    body["references"] = [
      {
        file: "reference-1.png",
        path: "/tmp/harness/reference-1.png",
        sha256: "a".repeat(64),
        bytes: 12_345,
        mediaType: "image/png",
        url: `/api/runs/${RUN_ID}/attachments/reference-1.png`,
      },
    ];
    body["documents"] = [
      {
        file: "document-1.pdf",
        path: "/tmp/harness/document-1.pdf",
        sha256: "b".repeat(64),
        bytes: 54_321,
        mediaType: "application/pdf",
        url: `/api/runs/${RUN_ID}/attachments/document-1.pdf`,
      },
    ];
    /*
     * AND ONE GENERATED MOCKUP, so the OTHER half of the sentence can be
     * checked rather than taken on trust. `splitCaptures` (lib/mockups.ts:222)
     * files a capture as a design reference when its label starts with
     * `MOCKUP_LABEL`, and `ScreenshotsPanel` then heads the disclosure "Design
     * references (n)". Without this the Result panel renders "No capture of the
     * site yet" and the spec could only assert that the sentence names Result,
     * never that Result is where the mockups actually are.
     */
    body["screenshots"] = [
      {
        path: "/tmp/harness/design-hero.png",
        label: "design mockup — hero",
        capturedAt: "2026-08-04T12:00:00.000Z",
      },
    ];
  });
}

test("the attachments panel still says these are YOURS and the mockups are not", async ({
  page,
}) => {
  await withAttachments(page);
  await openRun(page, RUN_ID);
  await openPanel(page, "overview");

  const ticket = page.getByTestId("overview-ticket");

  /*
   * THE DISTINCTION IS THE PANEL'S REASON TO EXIST — `attachments.tsx`'s header:
   * "A reader who merges the two mis-reads every verdict on the page." One side
   * is what the OWNER handed over, the other is what ui-designer GENERATED, and
   * the rewrite that removed the words "Verdict tab" had to keep both halves.
   *
   * MUTATION APPLIED: deleted the whole `<span className="text-ink-dim">…</span>`
   * carrying the second sentence from `attachments.tsx`. Three of the four
   * expectations below went red. Reverted.
   */
  /*
   * THE COUNT IS ASSERTED WITH THE SENTENCE, WHICH IS MORE THAN THE LINE IT
   * REPLACES CHECKED. The subtitle read "…attached to this ticket before the run
   * started" until 2026-08-05 and now reads `${total} file(s) attached to this
   * ticket.` (`attachments.tsx:284`, where `total` is `references.length +
   * documents.length`). Taking only the surviving fragment would have dropped a
   * clause without putting anything in its place, so the whole shipped sentence
   * is asserted INCLUDING the number — `withAttachments` injects exactly one
   * reference and one document, so "2 files" binds this expectation to the data
   * the test itself set up and reddens on a miscount as well as on a rewrite.
   */
  await expect(ticket).toContainText("2 files attached to this ticket.");
  await expect(ticket).toContainText("Not the design references under Result");
  await expect(ticket).toContainText("those are mockups ui-designer generated for this run");

  /*
   * AND IT POINTS AT A SURFACE THAT EXISTS. The sentence named the "Verdict tab"
   * until 2026-08-05 — deleted UI, so the reader who followed it found nothing.
   * `ScreenshotsPanel` is mounted by `ResultPanel`, and the rail entry is Result.
   */
  await expect(ticket).not.toContainText("Verdict tab");
  await openPanel(page, "result");
  await expect(page.getByTestId("rail-panel")).toContainText("Design references");
});

test("the Activity panel is headed Activity all the way down", async ({ page }) => {
  await openRun(page, RUN_ID);
  await openPanel(page, "activity");

  /*
   * THE CONTRADICTION THE OWNER COULD SEE ON ONE SCREEN: the rail said Activity,
   * the card inside said TRACE. Both headings are asserted together, because
   * fixing either one alone leaves the screen disagreeing with itself.
   *
   * MUTATION APPLIED: `title="Activity"` back to `title="Trace"` in
   * `run/trace.tsx`. The second expectation went red. Reverted.
   */
  const panel = page.getByTestId("rail-panel");
  await expect(panel.locator("> header h2")).toHaveText("Activity");
  await expect(panel.locator("section > header h2")).toHaveText("Activity");
});

/*
 * THE ONE MEANING THE PLAIN WORDS COULD MOST EASILY HAVE COST, and it is two
 * tests rather than one for a harness reason worth recording.
 *
 * `heldOutPass === null` means the tests never answered — the work was NOT judged
 * — and `false` means they answered and it did not pass. `notices.tsx` prints two
 * different sentences and they must not become substitutable in plainer words:
 * an owner who reads a harness fault as a grade throws away work nothing ever
 * looked at.
 *
 * WHY NOT ONE TEST WITH A RELOAD IN THE MIDDLE. It was written that way first and
 * failed for reasons that have nothing to do with the copy: a `page.route`
 * REGISTERED AFTER a load, followed by a second `goto`, leaves the run view
 * mounting with no run at all — the rail is absent and the assertion that reads
 * is "toolbar not found". Interception from before the first navigation is
 * reliable, so each state gets a page of its own.
 */
test("a graded failure says the work did not pass", async ({ page }) => {
  await openRun(page, FINISHED_RUN_ID);
  await openPanel(page, "result");
  const panel = page.getByTestId("rail-panel");
  await expect(panel).toContainText(
    "The run finished and the work did not pass the acceptance tests.",
  );
  await expect(panel).not.toContainText("never graded");
});

test("a run that was never graded says that instead", async ({ page }) => {
  /*
   * MUTATION APPLIED: collapsed the ternary in `notices.tsx` to the `false`
   * sentence for both branches. This test went red on "the work was never
   * graded" and the test above stayed green — which is the pair working.
   * Reverted.
   */
  await patchDetail(page, FINISHED_RUN_ID, (body) => {
    body["heldOutPass"] = null;
  });
  await openRun(page, FINISHED_RUN_ID);
  await openPanel(page, "result");
  const panel = page.getByTestId("rail-panel");
  await expect(panel).toContainText("the work was never graded");
  await expect(panel).toContainText("harness or infrastructure failure");
  await expect(panel).not.toContainText("did not pass the acceptance tests");
});
