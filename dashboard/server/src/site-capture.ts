/**
 * site-capture.ts — read the page a ticket names, ONCE, at ticket time.
 *
 * WHY THIS EXISTS, AND WHAT IT DOES *NOT* FIX.
 *
 * "Make a copy of kamilborzecki.dev" is graded by three seats and only one of
 * them can see the site:
 *
 *   - THE BUILDER runs on the host with unrestricted egress and the full tool
 *     preset (`builders/claude-builder.ts`), so it can fetch the page itself.
 *   - THE SPEC SEAT, which authors the pass/fail suite, is constructed with
 *     `tools: []` and `settingSources: []` (`subscription-caller.ts`). It cannot
 *     fetch a URL, cannot read a file, and gets TEXT ONLY. That is deliberate:
 *     the suite must never see an implementation.
 *   - THE GATE runs `docker run --network none`. It can never reach the original.
 *
 * So without this module the acceptance criteria for "copy that site" are
 * invented from the sentence alone, and a run can go green having built
 * something that looks nothing like the original.
 *
 * THIS MODULE CLOSES EXACTLY ONE HALF OF THAT. It runs on the HOST, at ticket
 * time, where the network exists, and turns the page into two artefacts:
 *
 *   1. A TEXT OUTLINE (title, headings in document order, link labels, an
 *      approximate palette) which is composed into the ticket brief by
 *      `ticket-refs.ts`, and therefore reaches the spec seat as TEXT. Criteria
 *      can then name real sections of the real site.
 *   2. SCREENSHOTS at three widths, written to disk beside the run. Those are
 *      for the BUILDER (and the design lane) to `Read`.
 *
 * WHAT IT STILL DOES NOT DO — AND MUST NOT BE DESCRIBED AS DOING. The offline
 * gate STILL never compares the build to the live original. It compares the
 * build to a suite that was written from a richer description. That is a better
 * yardstick; it is not a visual diff, and no code here produces one. The
 * `--network none` seal on the scorer is load-bearing and nothing in this file
 * attempts to weaken it.
 *
 * PLAYWRIGHT IS NOT A DECLARED DEPENDENCY OF THIS PACKAGE. It resolves at run
 * time only because the CLIENT package declares `@playwright/test` and node's
 * resolution walks up into `dashboard/node_modules` — verified in this session:
 *
 *     createRequire('<repo>/dashboard/server/dist/x.js').resolve('playwright')
 *       -> <repo>/dashboard/node_modules/playwright/index.js
 *
 * That is hoisting, not a contract. `server/package.json` should list it (see
 * the handoff in the change report). Until it does, an unresolvable import is a
 * NAMED, SOFT failure here rather than a crash: the run proceeds with no
 * capture and the reason is recorded.
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST A REAL BROWSER IN THE SESSION THAT
 * WROTE IT — a live dashboard held the shared browser lock, so chromium was
 * never launched. Every path below is exercised against the injected
 * {@link LaunchBrowser} seam in `site-capture.test.ts`, including five distinct
 * failure modes; the FIRST REAL CAPTURE IS THEREFORE UNVERIFIED and should be
 * watched. The seam exists for that reason as much as for testability.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/* -------------------------------------------------------------------------
 * What a capture is
 * ---------------------------------------------------------------------- */

/** One screenshot of the captured page, on disk. */
export interface CaptureShot {
  /** Viewport width in CSS pixels. Height is whatever the page needed. */
  readonly width: number;
  /** Absolute host path. The BUILDER reads this; the spec seat never sees it. */
  readonly path: string;
  /** sha256 of the PNG bytes. Recorded for provenance — see the identity note. */
  readonly sha256: string;
  readonly bytes: number;
}

export interface OutlineHeading {
  /** 1–4. Deeper headings are dropped: they are page detail, not structure. */
  readonly level: number;
  readonly text: string;
}

/**
 * The part of a capture that is TEXT, and therefore the part the spec seat can
 * be given.
 *
 * DELIBERATELY COARSE. This text is composed into the ticket brief, so it enters
 * the ticket digest — and every byte of volatility in it mints a new ticket id
 * and re-authors a suite, spending quota. A "latest posts" strip or a rotating
 * tagline would do that on every submission. Headings, link labels and a small
 * palette change when the SITE changes, which is a case where a new ticket is
 * the correct answer. Body copy, dates and counts are excluded for that reason,
 * not because they would be hard to extract.
 *
 * `headings` IS THE SECTION ORDER. It is emitted in document order and that
 * ordering is the only statement about layout this file makes; there is no
 * separate "sections" field, because a landmark-tag walk would be a second,
 * disagreeing answer to the same question.
 */
export interface SiteOutline {
  readonly url: string;
  readonly title: string;
  readonly headings: readonly OutlineHeading[];
  /** Anchor TEXT, not hrefs. What a copy has to reproduce; leaks no paths. */
  readonly links: readonly string[];
  /**
   * Colours found in the served markup, most frequent first.
   *
   * MAY LEGITIMATELY BE EMPTY, and empty is not "the site has no colours". Only
   * inline `style=` attributes and `<style>` blocks in the rendered DOM are
   * read; a site whose palette lives in an external stylesheet yields nothing
   * here. `outlineFromHtml` never invents one.
   */
  readonly palette: readonly string[];
}

export interface SiteCapture {
  readonly url: string;
  readonly capturedAt: string;
  readonly shots: readonly CaptureShot[];
  readonly outline: SiteOutline;
}

/**
 * A capture attempt's outcome.
 *
 * `ok: false` CARRIES A SENTENCE, NEVER A BARE FLAG. Every caller of this
 * module is expected to put `reason` in front of the owner: a ticket that says
 * "copy this site" and silently gets no capture is exactly the run that goes
 * green having never seen the site.
 */
export type SiteCaptureResult =
  | { readonly ok: true; readonly capture: SiteCapture }
  | { readonly ok: false; readonly reason: string };

/* -------------------------------------------------------------------------
 * Which URL, and whether we are allowed to fetch it
 * ---------------------------------------------------------------------- */

/**
 * What a ticket's text asks us to capture.
 *
 * THREE STATES, AND `refused` IS THE ONE THAT EARNS ITS KEEP. "no URL in the
 * ticket" and "there is a URL and this program will not open it" have different
 * remedies, and collapsing them would hide the refusal that matters most (see
 * the loopback rule below).
 */
export type CaptureTarget =
  | { readonly kind: "none" }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "refused"; readonly url: string; readonly reason: string };

/**
 * Trailing characters stripped off a URL grabbed out of prose.
 *
 * A brief says "copy https://example.com." and the sentence's full stop is not
 * part of the host. Closing brackets are stripped too — "(see https://x.dev)".
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** The first http(s) URL in the text, or nothing. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/i;

/**
 * Hosts this program refuses to point a browser at.
 *
 * THE FIRST ENTRY IS THE WHOLE REASON THIS FUNCTION EXISTS. This dashboard binds
 * 127.0.0.1 and every route on it can spend the owner's subscription quota,
 * start runs and read tickets. A ticket that says "copy http://127.0.0.1:4176"
 * would aim a headless browser at that API — from inside the process that serves
 * it. The private and link-local ranges are refused for the same class of
 * reason: nothing on the owner's LAN or on a cloud metadata endpoint is a
 * "website to copy", and a capture is an unattended fetch driven by text a
 * scheduler may have written.
 *
 * A BARE HOSTNAME WITH NO DOT is refused too (`http://intranet/`), because it
 * can only resolve through the machine's own search domains.
 *
 * This is a refusal list, not a security boundary: DNS still decides what a
 * public-looking name resolves to, and a name that resolves to 10.x is NOT
 * caught here. Closing that needs resolution-then-connect control, which
 * playwright does not offer, and pretending otherwise in this comment would be
 * the defect this file is trying to avoid.
 */
function refuseHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "it names this machine";
  }
  if (host === "::1" || host === "::" || host === "0.0.0.0") return "it names this machine";
  if (/^127\./.test(host)) return "it names this machine — the dashboard's own API lives there";
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return "it is a private network address";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "it is a private network address";
  if (/^169\.254\./.test(host)) return "it is a link-local address";
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return "it is a private IPv6 address";
  if (!host.includes(".")) return "it is not a public hostname";
  return null;
}

/**
 * Find the page a ticket is about.
 *
 * THE FIRST URL WINS, and that is a rule rather than a heuristic: a rule is
 * reproducible, and reproducibility is what makes the ticket id stable. It also
 * means a brief that merely CITES a URL ("see https://developer.mozilla.org/…")
 * gets that page captured. That is a real false positive with a real cost — the
 * capture spends wall-clock time and its outline enters the ticket digest — and
 * the opt-out is `captureUrl: null` on `POST /api/runs`, which is why that field
 * exists.
 */
export function captureTargetIn(text: string): CaptureTarget {
  const match = URL_PATTERN.exec(text);
  if (match === null) return { kind: "none" };
  const raw = match[0].replace(TRAILING_PUNCTUATION, "");
  return captureTargetFor(raw);
}

/** The same refusals, applied to a URL the CALLER chose rather than one found in prose. */
export function captureTargetFor(raw: string): CaptureTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: "refused", url: raw, reason: "it is not a URL this program can parse" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "refused", url: raw, reason: `${parsed.protocol} is not http or https` };
  }
  const hostRefusal = refuseHost(parsed.hostname);
  if (hostRefusal !== null) return { kind: "refused", url: raw, reason: hostRefusal };
  return { kind: "url", url: parsed.toString() };
}

/* -------------------------------------------------------------------------
 * Reading the page
 * ---------------------------------------------------------------------- */

/**
 * The three widths captured.
 *
 * The same three the GATE's own screenshots use, so the reference and the
 * result are comparable side by side on the Verdict tab rather than being two
 * differently-shaped sets of pictures.
 */
export const CAPTURE_WIDTHS: readonly number[] = [1280, 768, 375];

/** Viewport height. Every shot is `fullPage`, so this is only the fold. */
const VIEWPORT_HEIGHT = 900;

/**
 * The slice of playwright's `Page` this module uses.
 *
 * DECLARED STRUCTURALLY, AND THAT IS A REAL LIMIT ON THE TYPE-CHECKING HERE.
 * The real module is loaded through a dynamic import with a non-literal
 * specifier (see {@link playwrightLaunch}), so TypeScript types it `any` and
 * NOTHING checks that playwright's `Page` still satisfies this interface. A
 * playwright release that renames `setViewportSize` compiles clean and fails at
 * run time. That is the price of not declaring the dependency; the fake in the
 * tests satisfies the interface, the real browser is only checked by running it.
 */
export interface CapturePage {
  goto(url: string, options: { readonly waitUntil: "load"; readonly timeout: number }): Promise<unknown>;
  setViewportSize(size: { readonly width: number; readonly height: number }): Promise<unknown>;
  /**
   * `timeout` IS NOT OPTIONAL HERE ON PURPOSE. A `fullPage` screenshot of a tall
   * page with lazy images is the slowest thing this module does, and playwright
   * applies its own 30 s default to any action that is not given one. Three
   * un-timed shots were quietly worth 90 s of a request that documented itself
   * as costing ~25 s. Requiring the field means a future width cannot be added
   * without stating its budget.
   */
  screenshot(options: { readonly fullPage: boolean; readonly type: "png"; readonly timeout: number }): Promise<Uint8Array>;
  content(): Promise<string>;
  title(): Promise<string>;
}

export interface CaptureBrowser {
  newPage(): Promise<CapturePage>;
  close(): Promise<unknown>;
}

export type LaunchBrowser = () => Promise<CaptureBrowser>;

/**
 * The module specifier, held in a `string`-typed binding on purpose.
 *
 * `import("playwright")` with a literal would make TypeScript resolve the
 * package at COMPILE time, and this package does not declare it — the build
 * would fail on a machine where the client's node_modules is absent, which is
 * every clean checkout of the server alone. Widening to `string` makes the
 * import's type `any` and defers the whole question to run time, where the
 * failure is caught and named instead.
 */
const PLAYWRIGHT_MODULE: string = "playwright";

/**
 * THE THREE BUDGETS, AND THE HONEST TOTAL.
 *
 * A capture runs inside `POST /api/runs`, so its cost is the owner staring at a
 * submit button. Every playwright call that accepts a timeout is given one here
 * rather than inheriting the library's 30 s default, because the defaults
 * multiply: launch + navigate + three screenshots at 30 s apiece is two minutes
 * for a request that reads as instant when it works.
 *
 * WORST CASE, STATED RATHER THAN IMPLIED: 15 s launch + 20 s navigation +
 * 3 × 10 s screenshots = {@link CAPTURE_BUDGET_MS}, plus `content()` and
 * `title()`, which take no timeout argument in this interface and therefore
 * carry playwright's own page default. Those two return from an already-loaded
 * DOM and are the two calls a healthy page answers instantly, but they are NOT
 * bounded by anything in this file — so the true pathological ceiling is higher
 * than the number below, and anyone quoting a single figure to the owner should
 * quote it as "under a minute in practice", not as a guarantee.
 */
export const LAUNCH_TIMEOUT_MS = 15_000;
/** How long one `goto` may take. A slow site must not hold the POST open. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
/** How long one full-page screenshot may take. */
export const SCREENSHOT_TIMEOUT_MS = 10_000;
/** The sum of the bounded parts. See the caveat above: it is not the whole cost. */
export const CAPTURE_BUDGET_MS =
  LAUNCH_TIMEOUT_MS + DEFAULT_NAVIGATION_TIMEOUT_MS + CAPTURE_WIDTHS.length * SCREENSHOT_TIMEOUT_MS;

/**
 * Launch chromium through the hoisted playwright, or throw a sentence saying
 * why not.
 *
 * `headless` because this runs inside an HTTP handler on the owner's machine and
 * a window appearing when a ticket is submitted would be indefensible.
 */
export function playwrightLaunch(): LaunchBrowser {
  return async () => {
    let mod: {
      chromium?: { launch(options: { headless: boolean; timeout: number }): Promise<CaptureBrowser> };
    };
    try {
      mod = await import(PLAYWRIGHT_MODULE);
    } catch (error) {
      throw new Error(
        `playwright could not be loaded (${error instanceof Error ? error.message : String(error)}). ` +
          "It is not a declared dependency of dashboard/server; it resolves only through the client " +
          "package's node_modules. Run `npm install` in dashboard/, or add playwright to " +
          "dashboard/server/package.json.",
      );
    }
    const chromium = mod.chromium;
    if (chromium === undefined) {
      throw new Error("the resolved playwright module exports no `chromium` launcher");
    }
    // A first launch after `playwright install` unpacks the browser, so this is
    // not instant even on a healthy machine — but it is not thirty seconds
    // either, and an unbounded launch is a submit button that never returns.
    return await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS });
  };
}

export interface CaptureOptions {
  /** Already refused-or-accepted by {@link captureTargetIn}. */
  readonly url: string;
  /** Directory the PNGs are written into. Created by the caller. */
  readonly dir: string;
  /** Injected in tests. Defaults to real chromium. */
  readonly launch?: LaunchBrowser;
  readonly navigationTimeoutMs?: number;
  readonly screenshotTimeoutMs?: number;
  /** Injected in tests so a capture can be exercised without touching disk. */
  readonly writeFile?: (path: string, bytes: Uint8Array) => void;
  readonly now?: () => Date;
}

/**
 * Capture one page. NEVER THROWS.
 *
 * Every failure — playwright missing, chromium refusing to start, a navigation
 * timeout, a screenshot error, a page that returns nothing — comes back as
 * `{ok: false, reason}`. That is not defensive politeness: this runs inside
 * `POST /api/runs`, and a throw here would refuse to create a run at all because
 * a third-party site was slow. The ticket is still a ticket without its
 * reference; it is just a worse-specified one, and the caller says so.
 *
 * THE BROWSER IS CLOSED ON EVERY PATH, including the ones where the failure
 * happened mid-screenshot. A leaked chromium on a long-lived local server is a
 * process the owner finds three days later.
 *
 * A PARTIAL CAPTURE IS STILL A CAPTURE. If width 1280 succeeds and 375 throws,
 * the shots taken so far are kept and the outline is still returned; only a
 * failure that leaves ZERO shots is reported as a failed capture. Losing the
 * mobile width is worth less than losing the whole reference.
 */
export async function captureSite(options: CaptureOptions): Promise<SiteCaptureResult> {
  const launch = options.launch ?? playwrightLaunch();
  const timeout = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const write = options.writeFile ?? ((path: string, bytes: Uint8Array) => { writeFileSync(path, bytes); });
  const clock = options.now ?? (() => new Date());

  let browser: CaptureBrowser;
  try {
    browser = await launch();
  } catch (error) {
    return { ok: false, reason: `the browser could not be started: ${messageOf(error)}` };
  }

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: CAPTURE_WIDTHS[0] ?? 1280, height: VIEWPORT_HEIGHT });
    await page.goto(options.url, { waitUntil: "load", timeout });

    // READ THE DOM BEFORE THE SCREENSHOTS, and read it once. `content()` returns
    // the RENDERED markup, so a client-rendered page is included; taking it after
    // three viewport changes would describe the narrowest layout, which is the
    // one a responsive site collapses.
    let html = "";
    let pageTitle = "";
    try {
      html = await page.content();
      pageTitle = await page.title();
    } catch (error) {
      // A screenshot may still be possible, and a picture with no outline is
      // worth more to the builder than nothing. The spec seat loses out, which
      // is why this is not silent.
      html = "";
      pageTitle = `(the page's markup could not be read: ${messageOf(error)})`;
    }

    const shots: CaptureShot[] = [];
    let shotFailure: string | null = null;
    for (const width of CAPTURE_WIDTHS) {
      try {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        const bytes = await page.screenshot({
          fullPage: true,
          type: "png",
          timeout: options.screenshotTimeoutMs ?? SCREENSHOT_TIMEOUT_MS,
        });
        const path = join(options.dir, `capture-${String(width)}.png`);
        write(path, bytes);
        shots.push({
          width,
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        });
      } catch (error) {
        shotFailure = messageOf(error);
      }
    }

    if (shots.length === 0) {
      return { ok: false, reason: `no screenshot could be taken: ${shotFailure ?? "no reason reported"}` };
    }

    return {
      ok: true,
      capture: {
        url: options.url,
        capturedAt: clock().toISOString(),
        shots,
        outline: outlineFromHtml(html, options.url, pageTitle),
      },
    };
  } catch (error) {
    return { ok: false, reason: `the page could not be read: ${messageOf(error)}` };
  } finally {
    // Deliberately swallowed: a browser that fails to close must not turn a
    // successful capture into a failed one.
    try {
      await browser.close();
    } catch {
      /* nothing to do about it, and nothing worth saying */
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------
 * HTML -> outline
 *
 * REGEXES OVER MARKUP, WITH THE USUAL CAVEAT AND ONE UNUSUAL MITIGATION. Parsing
 * HTML with regular expressions is wrong in general. It is defensible here
 * because the OUTPUT IS PROSE FOR A LANGUAGE MODEL, not a DOM: a heading missed
 * because it was wrapped oddly costs one line of description, and there is no
 * downstream code that indexes into this structure. The alternative — a real
 * parser — is a dependency this package does not have, and shelling the work
 * into `page.evaluate` would move it into the browser where NO TEST CAN REACH
 * IT. Everything below is a pure function over a string, which is why the test
 * file can hold twenty cases for it.
 * ---------------------------------------------------------------------- */

/** How many headings survive. Past this it stops being an outline. */
const MAX_HEADINGS = 40;
/** How many distinct link labels survive. Navigation, not a sitemap. */
const MAX_LINKS = 30;
/** How many colours are reported. */
const MAX_PALETTE = 8;
const MAX_TEXT = 120;

function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The five entities that actually matter in headings and link labels.
 *
 * NOT A GENERAL DECODER, and it does not pretend to be: an unhandled entity
 * survives as its literal `&…;`, which reads slightly oddly in a prompt and
 * breaks nothing.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'");
}

function clamp(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** Everything inside `<script>`/`<style>` that would otherwise read as content. */
function withoutScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
}

/**
 * Turn rendered markup into the outline the spec seat is given.
 *
 * PURE, TOTAL, AND NEVER THROWS. Empty input yields an outline with an empty
 * title and empty lists — which is a truthful statement ("nothing could be read
 * from this page") and is rendered as such by `ticket-refs.ts` rather than as an
 * empty section that reads like a site with no headings.
 */
export function outlineFromHtml(html: string, url: string, fallbackTitle: string): SiteOutline {
  const body = withoutScripts(html);

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch === undefined || titleMatch === null ? "" : stripTags(titleMatch[1] ?? "");

  const headings: OutlineHeading[] = [];
  const headingPattern = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of body.matchAll(headingPattern)) {
    if (headings.length >= MAX_HEADINGS) break;
    const text = stripTags(match[2] ?? "");
    if (text.length === 0) continue;
    headings.push({ level: Number.parseInt(match[1] ?? "1", 10), text: clamp(text) });
  }

  const links: string[] = [];
  const seenLinks = new Set<string>();
  for (const match of body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= MAX_LINKS) break;
    const text = stripTags(match[1] ?? "");
    // A one-character label is an icon; a 60-character one is a sentence that
    // happens to be linked. Neither is navigation.
    if (text.length < 2 || text.length > 60) continue;
    const key = text.toLowerCase();
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push(text);
  }

  return {
    url,
    title: title.length > 0 ? title : fallbackTitle,
    headings,
    links,
    palette: paletteFromHtml(body),
  };
}

/**
 * The colours the served markup states outright.
 *
 * ONLY `<style>` BLOCKS AND `style=` ATTRIBUTES, because those are the only
 * declarations present in the string this function is given. An external
 * stylesheet is a separate HTTP response that nothing here fetches, so a site
 * built the normal way will often return `[]`. THAT EMPTY ARRAY IS THE HONEST
 * ANSWER and `ticket-refs.ts` omits the palette line entirely rather than
 * printing "palette: none", which would read as a fact about the site.
 *
 * Ranked by how often each colour is written, which approximates prominence and
 * is stable across submissions — an ordering by first appearance would reshuffle
 * whenever a rule moved, and the order is inside the ticket digest.
 */
export function paletteFromHtml(html: string): readonly string[] {
  const declarations: string[] = [];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) declarations.push(match[1] ?? "");
  for (const match of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) declarations.push(match[1] ?? "");
  for (const match of html.matchAll(/\bstyle\s*=\s*'([^']*)'/gi)) declarations.push(match[1] ?? "");

  const counts = new Map<string, number>();
  const colourPattern = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;
  for (const declaration of declarations) {
    for (const match of declaration.matchAll(colourPattern)) {
      const colour = normaliseColour(match[0]);
      if (colour === null) continue;
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .slice(0, MAX_PALETTE)
    .map(([colour]) => colour);
}

/**
 * One spelling per colour, so `#FFF` and `#ffffff` are not two palette entries.
 *
 * Only the hex forms are expanded; `rgb()` is lowercased and whitespace-collapsed
 * but NOT converted to hex, because `rgba(0,0,0,.5)` has no hex equivalent and a
 * lossy conversion would report a colour the site does not use.
 */
function normaliseColour(raw: string): string | null {
  const value = raw.toLowerCase().replace(/\s+/g, "");
  if (value.startsWith("#")) {
    const digits = value.slice(1);
    if (digits.length === 3) return `#${digits[0] ?? ""}${digits[0] ?? ""}${digits[1] ?? ""}${digits[1] ?? ""}${digits[2] ?? ""}${digits[2] ?? ""}`;
    if (digits.length === 6 || digits.length === 8) return `#${digits}`;
    return null;
  }
  return value;
}
