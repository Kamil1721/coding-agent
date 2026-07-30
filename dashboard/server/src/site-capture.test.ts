/**
 * site-capture.test.ts — the five ways a capture fails, and the one way it works.
 *
 * NO REAL BROWSER IS LAUNCHED BY THIS FILE, AND NONE WAS LAUNCHED WHEN IT WAS
 * WRITTEN. A live dashboard held the shared browser lock, so chromium has never
 * executed against `captureSite`. Everything below drives the injected
 * {@link LaunchBrowser} seam. What that proves and what it does not:
 *
 *   PROVEN — the control flow. A failure at any stage produces `{ok:false}` with
 *   a sentence, the browser is closed on every path including the failures, a
 *   partial capture is kept, and the outline extractor is exercised against real
 *   markup.
 *
 *   NOT PROVEN — that playwright's `Page` still satisfies `CapturePage`, that
 *   chromium starts on this machine, or that a real site renders in time. Those
 *   need one real run, and the first one should be watched. The fake here
 *   satisfies the interface BY CONSTRUCTION, which is exactly the thing a fake
 *   cannot check.
 *
 * THE REFUSAL TESTS ARE THE ONES THAT MATTER MOST. `captureTargetIn` reads text
 * that a cron job may have written, and points a browser at whatever it finds.
 * A ticket saying "copy http://127.0.0.1:4176" would aim it at this dashboard's
 * own API — the one that spends the owner's subscription quota — from inside the
 * process that serves it.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CAPTURE_BUDGET_MS,
  CAPTURE_WIDTHS,
  LAUNCH_TIMEOUT_MS,
  captureSite,
  captureTargetFor,
  captureTargetIn,
  outlineFromHtml,
  paletteFromHtml,
} from "./site-capture.js";
import type { CaptureBrowser, CapturePage } from "./site-capture.js";

/* -------------------------------------------------------------------------
 * Which URL, and whether we will open it
 * ---------------------------------------------------------------------- */

test("the first http(s) URL in the ticket wins, with sentence punctuation stripped", () => {
  assert.deepEqual(captureTargetIn("Make a copy of https://kamilborzecki.dev please"), {
    kind: "url",
    url: "https://kamilborzecki.dev/",
  });
  assert.deepEqual(captureTargetIn("Copy https://example.com/about."), {
    kind: "url",
    url: "https://example.com/about",
  });
  assert.deepEqual(captureTargetIn("Copy this (https://example.com/a), please"), {
    kind: "url",
    url: "https://example.com/a",
  });
  assert.equal(captureTargetIn("Build me a portfolio site").kind, "none");
  assert.equal(captureTargetIn("").kind, "none");
  // FIRST, not best. A rule, because reproducibility is what makes the ticket id
  // stable — and the cost of the rule is the false positive the `captureUrl: null`
  // opt-out exists for.
  assert.deepEqual(captureTargetIn("Like https://a.example then https://b.example"), {
    kind: "url",
    url: "https://a.example/",
  });
});

test("this machine, the LAN and link-local are REFUSED, with the reason attached", () => {
  for (const url of [
    "http://127.0.0.1:4176/api/runs",
    "http://localhost:3000",
    "http://[::1]:8080",
    "http://0.0.0.0:80",
    "http://10.0.0.5",
    "http://192.168.1.10",
    "http://172.20.0.3",
    "http://169.254.169.254/latest/meta-data/",
    "http://printer.local",
    "http://intranet/",
  ]) {
    const target = captureTargetIn(`copy ${url}`);
    assert.equal(target.kind, "refused", `${url} must not be captured`);
    if (target.kind === "refused") {
      assert.ok(target.reason.length > 0, "a refusal with no reason is a silent drop");
    }
  }
});

test("a public-looking host in a private range's neighbourhood is still allowed", () => {
  // The boundary of the 172.16/12 block. `172.15.x` and `172.32.x` are public.
  assert.equal(captureTargetIn("copy http://172.15.0.1/").kind, "url");
  assert.equal(captureTargetIn("copy http://172.32.0.1/").kind, "url");
  assert.equal(captureTargetIn("copy http://172.16.0.1/").kind, "refused");
  assert.equal(captureTargetIn("copy http://172.31.255.255/").kind, "refused");
});

test("captureTargetFor applies the same refusals to a URL the caller chose", () => {
  assert.equal(captureTargetFor("https://example.com").kind, "url");
  assert.equal(captureTargetFor("http://localhost").kind, "refused");
  assert.equal(captureTargetFor("file:///etc/passwd").kind, "refused");
  assert.equal(captureTargetFor("javascript:alert(1)").kind, "refused");
  assert.equal(captureTargetFor("not a url at all").kind, "refused");
});

/* -------------------------------------------------------------------------
 * The fake browser
 * ---------------------------------------------------------------------- */

interface FakeOptions {
  readonly html?: string;
  readonly title?: string;
  readonly failGoto?: string;
  readonly failContent?: string;
  /** Throw on the Nth screenshot (1-based). 0 = never. */
  readonly failScreenshotFrom?: number;
}

interface Fake {
  readonly browser: CaptureBrowser;
  readonly state: {
    closed: boolean;
    screenshots: number;
    gotoUrl: string | null;
    /** Every timeout the module actually asked for. Zero means it asked for none. */
    timeouts: number[];
  };
}

function fakeBrowser(options: FakeOptions = {}): Fake {
  const state = { closed: false, screenshots: 0, gotoUrl: null as string | null, timeouts: [] as number[] };
  const page: CapturePage = {
    goto: (url, gotoOptions) => {
      state.gotoUrl = url;
      state.timeouts.push(gotoOptions.timeout);
      if (options.failGoto !== undefined) return Promise.reject(new Error(options.failGoto));
      return Promise.resolve(null);
    },
    setViewportSize: () => Promise.resolve(null),
    screenshot: (shotOptions) => {
      state.screenshots += 1;
      state.timeouts.push(shotOptions.timeout);
      const failFrom = options.failScreenshotFrom ?? 0;
      if (failFrom > 0 && state.screenshots >= failFrom) {
        return Promise.reject(new Error("target closed"));
      }
      // Distinct bytes per shot so the digests differ, which is what a caller
      // recording provenance would notice if this returned a constant.
      return Promise.resolve(new Uint8Array([137, 80, 78, 71, state.screenshots]));
    },
    content: () =>
      options.failContent === undefined
        ? Promise.resolve(options.html ?? "<html></html>")
        : Promise.reject(new Error(options.failContent)),
    title: () => Promise.resolve(options.title ?? ""),
  };
  return {
    state,
    browser: {
      newPage: () => Promise.resolve(page),
      close: () => {
        state.closed = true;
        return Promise.resolve(null);
      },
    },
  };
}

const PAGE_HTML = `<!doctype html><html><head><title>Kamil Borzęcki</title>
<style>body{background:#FFF;color:#111111} a{color:#111111}</style></head>
<body><header><a href="/">Home</a><a href="/work">Work</a></header>
<h1>Kamil Borzęcki</h1><p>Ignore this paragraph.</p>
<h2>Selected work</h2><h3>Bake-off</h3><h2>Writing</h2>
<script>document.title = "not the title"</script>
<footer><a href="mailto:x@y.z">Contact</a></footer></body></html>`;

function captured(): { readonly writes: { path: string; bytes: number }[]; readonly write: (p: string, b: Uint8Array) => void } {
  const writes: { path: string; bytes: number }[] = [];
  return { writes, write: (path, bytes) => writes.push({ path, bytes: bytes.byteLength }) };
}

/* -------------------------------------------------------------------------
 * The happy path
 * ---------------------------------------------------------------------- */

test("a capture yields one shot per width, the outline, and closes the browser", async () => {
  const fake = fakeBrowser({ html: PAGE_HTML });
  const disk = captured();
  const result = await captureSite({
    url: "https://kamilborzecki.dev/",
    dir: "/tmp/refs",
    launch: () => Promise.resolve(fake.browser),
    writeFile: disk.write,
    now: () => new Date("2026-07-30T12:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(fake.state.gotoUrl, "https://kamilborzecki.dev/");
  assert.equal(result.capture.shots.length, CAPTURE_WIDTHS.length);
  assert.deepEqual(
    result.capture.shots.map((shot) => shot.width),
    [...CAPTURE_WIDTHS],
  );
  assert.equal(disk.writes.length, CAPTURE_WIDTHS.length, "every shot reached disk");
  assert.ok(disk.writes[0]?.path.endsWith("/capture-1280.png"));
  assert.equal(result.capture.capturedAt, "2026-07-30T12:00:00.000Z");
  assert.equal(result.capture.outline.title, "Kamil Borzęcki");
  assert.equal(fake.state.closed, true, "a leaked chromium is a process the owner finds three days later");

  // The digests are of the bytes, and differ per shot. A constant here would
  // mean the provenance record says three identical pictures were taken.
  const digests = new Set(result.capture.shots.map((shot) => shot.sha256));
  assert.equal(digests.size, CAPTURE_WIDTHS.length);
});

test("EVERY playwright call that can hang is given a timeout, and they sum to the stated budget", () => {
  /*
   * THE DEFECT THIS PINS, WHICH SHIPPED ONCE ALREADY IN THIS FILE'S FIRST DRAFT.
   * `goto` was timed and the three `screenshot` calls were not, so they
   * inherited playwright's 30 s default — a request documented as costing ~25 s
   * whose real ceiling was over 90. A missing timeout is invisible: the code
   * reads fine, the tests pass, and only a hanging site shows it.
   *
   * Asserted through the FAKE, which records what it was asked for, so this
   * fails if a timeout is dropped at the call site — not merely if a constant
   * is renamed.
   */
  return (async () => {
    const fake = fakeBrowser({ html: PAGE_HTML });
    await captureSite({
      url: "https://example.com",
      dir: "/tmp/refs",
      launch: () => Promise.resolve(fake.browser),
      writeFile: () => undefined,
    });
    assert.equal(
      fake.state.timeouts.length,
      1 + CAPTURE_WIDTHS.length,
      "one navigation plus one screenshot per width, each with a stated budget",
    );
    assert.ok(
      fake.state.timeouts.every((value) => value > 0),
      "a zero or absent timeout is playwright's 30 s default wearing a number",
    );
    assert.equal(
      fake.state.timeouts.reduce((sum, value) => sum + value, 0) + LAUNCH_TIMEOUT_MS,
      CAPTURE_BUDGET_MS,
      "the constant the HTTP layer quotes to the owner is the sum of what is actually requested",
    );
  })();
});

/* -------------------------------------------------------------------------
 * The five failures
 * ---------------------------------------------------------------------- */

test("the browser failing to start is a named refusal, not a throw", async () => {
  const result = await captureSite({
    url: "https://example.com",
    dir: "/tmp/refs",
    launch: () => Promise.reject(new Error("Executable doesn't exist at .../chrome")),
    writeFile: () => undefined,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /browser could not be started/);
  assert.match(result.reason, /Executable doesn't exist/, "the real cause survives, or nobody can fix it");
});

test("an unresolvable playwright is reported as a missing dependency, not as a bad site", async () => {
  // The shape of the real default launcher's failure. It is a distinct cause
  // with a distinct fix (install it) from "the site is down", and conflating
  // them would send the owner after the wrong thing.
  const result = await captureSite({
    url: "https://example.com",
    dir: "/tmp/refs",
    launch: () =>
      Promise.reject(
        new Error(
          "playwright could not be loaded (Cannot find module 'playwright'). It is not a declared " +
            "dependency of dashboard/server.",
        ),
      ),
    writeFile: () => undefined,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not a declared dependency/);
});

test("a navigation timeout closes the browser and reports the page, not the browser", async () => {
  const fake = fakeBrowser({ failGoto: "Timeout 25000ms exceeded" });
  const result = await captureSite({
    url: "https://slow.example",
    dir: "/tmp/refs",
    launch: () => Promise.resolve(fake.browser),
    writeFile: () => undefined,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /page could not be read/);
  assert.match(result.reason, /Timeout 25000ms/);
  assert.equal(fake.state.closed, true, "closed even though the failure happened mid-navigation");
});

test("no screenshot at all is a failed capture", async () => {
  const fake = fakeBrowser({ html: PAGE_HTML, failScreenshotFrom: 1 });
  const result = await captureSite({
    url: "https://example.com",
    dir: "/tmp/refs",
    launch: () => Promise.resolve(fake.browser),
    writeFile: () => undefined,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no screenshot could be taken/);
  assert.match(result.reason, /target closed/);
  assert.equal(fake.state.closed, true);
});

test("SOME screenshots is still a capture — losing the mobile width beats losing the reference", async () => {
  const fake = fakeBrowser({ html: PAGE_HTML, failScreenshotFrom: 2 });
  const disk = captured();
  const result = await captureSite({
    url: "https://example.com",
    dir: "/tmp/refs",
    launch: () => Promise.resolve(fake.browser),
    writeFile: disk.write,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.capture.shots.length, 1);
  assert.equal(result.capture.shots[0]?.width, 1280);
  assert.equal(result.capture.outline.headings.length > 0, true, "the outline is unaffected by a shot failing");
});

test("markup that cannot be read still yields pictures, and SAYS the markup is missing", async () => {
  // The half-failure worth keeping distinct: the builder still gets something to
  // look at, and the spec seat is told why its outline is empty rather than
  // being handed a page that appears to have no headings.
  const fake = fakeBrowser({ failContent: "Execution context was destroyed" });
  const result = await captureSite({
    url: "https://example.com",
    dir: "/tmp/refs",
    launch: () => Promise.resolve(fake.browser),
    writeFile: () => undefined,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.capture.shots.length, CAPTURE_WIDTHS.length);
  assert.equal(result.capture.outline.headings.length, 0);
  assert.match(result.capture.outline.title, /could not be read/);
});

test("a browser that fails to close does not turn a good capture into a failure", async () => {
  const fake = fakeBrowser({ html: PAGE_HTML });
  const browser: CaptureBrowser = {
    newPage: () => fake.browser.newPage(),
    close: () => Promise.reject(new Error("browser already gone")),
  };
  const result = await captureSite({
    url: "https://example.com",
    dir: "/tmp/refs",
    launch: () => Promise.resolve(browser),
    writeFile: () => undefined,
  });
  assert.equal(result.ok, true);
});

/* -------------------------------------------------------------------------
 * The outline extractor — a pure function, so it can be pinned properly
 * ---------------------------------------------------------------------- */

test("headings come out in document order, with their levels", () => {
  const outline = outlineFromHtml(PAGE_HTML, "https://k.dev/", "");
  assert.deepEqual(outline.headings, [
    { level: 1, text: "Kamil Borzęcki" },
    { level: 2, text: "Selected work" },
    { level: 3, text: "Bake-off" },
    { level: 2, text: "Writing" },
  ]);
});

test("link LABELS are extracted, deduped, and hrefs are not", () => {
  const outline = outlineFromHtml(PAGE_HTML, "https://k.dev/", "");
  assert.deepEqual(outline.links, ["Home", "Work", "Contact"]);
  assert.ok(!JSON.stringify(outline).includes("mailto:"), "an href is a path, not a label");
});

test("script contents never reach the outline", () => {
  const outline = outlineFromHtml(PAGE_HTML, "https://k.dev/", "");
  assert.equal(outline.title, "Kamil Borzęcki", "not the value the inline script assigns");
  assert.ok(!JSON.stringify(outline).includes("document.title"));
});

test("the title falls back to what the browser reported, and only then", () => {
  assert.equal(outlineFromHtml("<html><body></body></html>", "u", "From The Browser").title, "From The Browser");
  assert.equal(outlineFromHtml("<title>From The Markup</title>", "u", "From The Browser").title, "From The Markup");
});

test("empty and broken markup produce an empty outline rather than a throw", () => {
  const empty = outlineFromHtml("", "https://k.dev/", "");
  assert.deepEqual(empty, { url: "https://k.dev/", title: "", headings: [], links: [], palette: [] });
  // Unclosed tags, nested markup inside a heading, entities.
  const messy = outlineFromHtml("<h1><span>A &amp; B</h1><h2>Unclosed", "u", "");
  assert.deepEqual(messy.headings, [{ level: 1, text: "A & B" }]);
});

test("the palette is what the markup declares, ranked, normalised, and EMPTY when external", () => {
  assert.deepEqual(paletteFromHtml(PAGE_HTML), ["#111111", "#ffffff"], "#FFF expands and #111111 is used twice");
  // THE ORDINARY CASE ON A REAL SITE, and the reason `ticket-refs.ts` omits the
  // palette line entirely rather than printing "none": a stylesheet this
  // function never fetches is not a site without colours.
  assert.deepEqual(paletteFromHtml('<link rel="stylesheet" href="/a.css"><h1>Hi</h1>'), []);
  assert.deepEqual(paletteFromHtml('<div style="color:#ABC">x</div>'), ["#aabbcc"]);
  assert.deepEqual(paletteFromHtml("<style>a{color:rgba(0, 0, 0, .5)}</style>"), ["rgba(0,0,0,.5)"]);
});

test("headings, links and labels are capped so an outline stays an outline", () => {
  const many = Array.from({ length: 60 }, (_, index) => `<h2>Heading ${String(index)}</h2>`).join("");
  assert.equal(outlineFromHtml(many, "u", "").headings.length, 40);

  const long = `<h1>${"x".repeat(400)}</h1>`;
  assert.equal(outlineFromHtml(long, "u", "").headings[0]?.text.length, 120);

  // A 400-character sentence that happens to be a link is not navigation.
  const sentence = `<a href="/">${"y".repeat(400)}</a><a href="/b">Ok</a>`;
  assert.deepEqual(outlineFromHtml(sentence, "u", "").links, ["Ok"]);
});
