/**
 * preview-through-next.test.ts — the preview route AS THE OWNER REACHES IT: a
 * REAL Next server, booted from this repository's own `next.config.ts`, in front
 * of a REAL dashboard backend, serving a REAL root-absolute document.
 *
 * WHY THIS FILE EXISTS, and it is not "more coverage of the same thing".
 * `preview-route.test.ts` boots the backend ALONE and passes 11/11 while the
 * address the owner actually clicks —
 * `http://127.0.0.1:4319/api/runs/<id>/preview/` — answered
 * `net::ERR_TOO_MANY_REDIRECTS` for 104 commits. Two independent pieces of
 * configuration made that invisible:
 *
 *   1. the Next rewrite is only in the path when a request goes to the CLIENT
 *      origin, and no test in this repository sent one there. The Playwright
 *      harness sets `NEXT_PUBLIC_API_BASE_URL` on its dev server
 *      (`playwright.config.ts`), which points every browser spec straight at the
 *      backend — the one configuration in which the loop CANNOT happen;
 *   2. the backend-only fixture's document links its stylesheet RELATIVELY, and
 *      both of the owner's real artefacts link theirs ROOT-ABSOLUTELY
 *      (`href="/styles.css"`), which is a different failure with a different
 *      fix.
 *
 * So the two things that were broken were the two things the suite was
 * configured out of being able to see. This file removes both exemptions.
 *
 * IT BOOTS NEXT PROGRAMMATICALLY, ON AN EPHEMERAL PORT, AND THAT IS DELIBERATE.
 * `next dev`'s CLI needs a fixed port and a fixed build directory, so a test
 * using it would collide with the owner's 4319 and with the Playwright harness.
 * `next({ dev: true, dir })` mounted on a `port: 0` server costs ~250-700 ms,
 * binds a port nobody else can be holding, and — the point — evaluates the SAME
 * `next.config.ts` the owner's `npm run dev` and `npm run build` evaluate. A
 * config change that reintroduces the loop cannot pass this file.
 *
 * `NEXT_TEST_DIST_DIR` IS `.next-test` AND MUST STAY THAT WAY. Booting Next
 * against any OTHER build directory makes it append that directory's `types`
 * globs to `dashboard/tsconfig.json` and reformat the file — measured, on this
 * tree, by this test's first draft. `.next` and `.next-test` are the two the
 * tsconfig already lists, and `.next` is the owner's real build. The cost is
 * that this file cannot run at the same time as `dashboard`'s Playwright suite:
 * Next locks its build directory and the second one to start fails loudly. That
 * is the right failure — a skip here would be one more check that can only
 * observe success.
 *
 * WHAT IT STILL DOES NOT PROVE. Nothing here is a browser, so the CSP is not
 * enforced and no pixel is painted; the rendering evidence for this route is a
 * screenshot taken by hand against the two real artefacts. What this file pins
 * is the network truth underneath it: how many hops the owner's URL costs, and
 * whether the addresses the served document names come back as the assets they
 * claim to be.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import { ensureDirs, ensureRunDirs, resolvePaths, runPathsFor } from "./paths.js";

/**
 * The run whose workspace holds a site written the way THE OWNER'S BUILDS WRITE
 * THEM.
 *
 * Both finished artefacts on this machine were checked before this fixture was
 * written, and they disagree — which is why the fixture carries both spellings:
 *
 *   run-2026-07-30T20-16-40-242Z-052c6e02/workspace/index.html
 *     href="/styles.css"  src="/main.js"  poster="/assets/world/leg-1-poster.webp"
 *   run-2026-07-29T23-28-46-665Z-3d4d1ccb/workspace/index.html
 *     href="styles.css"   (relative, and it always worked)
 *
 * A fixture with only the relative spelling is what let the unstyled page ship.
 */
const SITE_RUN_ID = "run-preview-root-absolute";

const INDEX_MARKER = "PREVIEW_NEXT_INDEX_MARKER:the workshop hero";
const CSS_MARKER = "PREVIEW_NEXT_CSS_MARKER";
const JS_MARKER = "PREVIEW_NEXT_JS_MARKER";

/** A PNG signature plus a few bytes, so an image can be compared byte-for-byte. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x49, 0x48]);

/** `dashboard/`, from `dashboard/server/<outDir>/` at run time. */
const DASHBOARD_DIR = join(import.meta.dirname, "..", "..");

/* -------------------------------------------------------------------------
 * The backend, exactly as `index.ts` wires it
 * ---------------------------------------------------------------------- */

interface Backend {
  readonly origin: string;
  readonly bus: RunEventBus;
  close(): Promise<void>;
}

function writeSite(workspace: string): void {
  /*
   * EVERY REFERENCE SHAPE A GENERATED PAGE USES, in one document, because the
   * fix for the root-absolute ones must not touch the others:
   *
   *   /styles.css                  root-absolute  -> must be re-pointed
   *   /main.js                     root-absolute  -> must be re-pointed
   *   /assets/poster%20frame.png   root-absolute AND percent-encoded
   *   url(/assets/hero.png)        root-absolute inside CSS
   *   assets/hero.png              relative       -> must be left ALONE
   *   https://example.com/…        absolute       -> must be left ALONE
   *   //example.com/…              protocol-relative -> must be left ALONE
   *   #top, mailto:                neither        -> must be left ALONE
   */
  writeFileSync(
    join(workspace, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en"><head>',
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="https://example.com/vendor.css">',
      "<style>body { background-image: url(/assets/hero.png) }</style>",
      "</head><body>",
      `<h1>${INDEX_MARKER}</h1>`,
      '<a href="#top">top</a> <a href="mailto:someone@example.com">mail</a>',
      '<img id="root-absolute" src="/assets/hero.png" alt="">',
      '<img id="relative" src="assets/hero.png" alt="">',
      '<video id="poster" poster="/assets/poster%20frame.png"></video>',
      '<script src="//example.com/vendor.js"></script>',
      '<script src="/main.js"></script>',
      "</body></html>",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "styles.css"),
    `body { color: #111; background: url(/assets/hero.png) } /* ${CSS_MARKER} */\n`,
    "utf8",
  );
  writeFileSync(join(workspace, "main.js"), `console.log("${JS_MARKER}");\n`, "utf8");
  mkdirSync(join(workspace, "assets"), { recursive: true });
  writeFileSync(join(workspace, "assets", "hero.png"), PNG_BYTES);
  // A space in the filename: `:path*` re-encodes per segment and `:path(.*)`
  // does not, so the rewrite source is not free to change without this.
  writeFileSync(join(workspace, "assets", "poster frame.png"), PNG_BYTES);
}

async function startBackend(): Promise<Backend> {
  const dir = mkdtempSync(join(tmpdir(), "dash-preview-next-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const runPaths = runPathsFor(paths, SITE_RUN_ID);
  ensureRunDirs(runPaths);
  writeSite(runPaths.workspace);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  store.createRun({
    runId: SITE_RUN_ID,
    ticketId: "t-1",
    ticketTitle: "A workshop landing page",
    ticketText: "Build it.",
    ticketSha256: "0".repeat(64),
    modelId: "opus[1m]",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });

  const claudeBin = join(dir, "claude-stub");
  writeFileSync(claudeBin, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(claudeBin, 0o755);
  const auth = new AuthProbe({ claudeBin, codexBin: claudeBin, env: {} });
  const catalog = new ModelCatalog(auth, {}, async () => []);
  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: () => false,
    resume: () => false,
    pushLiveMessage: () => false,
  };

  const server = createDashboardServer({ store, bus, orchestrator, catalog, auth, paths });
  await new Promise<void>((done) => {
    server.listen({ host: "127.0.0.1", port: 0 }, () => done());
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    bus,
    close: async (): Promise<void> => {
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------
 * Next itself
 * ---------------------------------------------------------------------- */

interface NextHarness {
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * The Next dev server, booted programmatically in a CHILD PROCESS.
 *
 * IN-PROCESS WAS TRIED FIRST AND CANNOT BE UNDONE. `next({dev:true})` mounted on
 * this process's own `http` server works and is 400 ms faster, but nothing
 * releases it: after `server.close()` AND `app.close()`,
 * `process.getActiveResourcesInfo()` still reports
 *
 *   ["PipeWrap","PipeWrap","FSEventWrap" ×11,"Timeout"]
 *
 * five seconds later, so the file never exits and `node --test` waits on it
 * forever — every other test file in this package included. A child that is
 * SIGKILLed takes its watchers with it. The `-e` script is inline rather than a
 * fixture file because `tsc` copies no non-`.ts` assets into the outDir, and a
 * boot script that only exists in `src/` is a boot script that works until
 * someone runs the compiled suite.
 *
 * `cwd` IS THE DASHBOARD, so `-e`'s bare `import("next")` resolves against
 * `dashboard/node_modules`. `port: 0` on both servers: this file must never be
 * able to answer for — or collide with — the owner's 4319 or 4176.
 */
const NEXT_BOOT_SCRIPT = `
import { createServer } from "node:http";
const nextFactory = (await import("next")).default;
const app = nextFactory({
  dev: true,
  dir: process.cwd(),
  hostname: "127.0.0.1",
  port: 0,
  quiet: true,
});
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((request, response) => {
  handler(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("PREVIEW_TEST_PORT=" + String(server.address().port) + "\\n");
});
`;

async function startNext(apiOrigin: string): Promise<NextHarness> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", NEXT_BOOT_SCRIPT], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      // READ AT CONFIG-EVALUATION TIME, inside `prepare()`. `next.config.ts`
      // bakes the rewrite destination from this variable, which is the
      // documented way to aim the proxy at a backend that is not on 4176 — and
      // this backend is on an ephemeral port precisely so it can never be the
      // owner's.
      DASHBOARD_API_ORIGIN: apiOrigin,
      // See the file header: any other value rewrites `dashboard/tsconfig.json`.
      NEXT_TEST_DIST_DIR: ".next-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `the Next dev server did not report a port within 120s.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 120_000);
    const check = (): void => {
      const found = /PREVIEW_TEST_PORT=(\d+)/.exec(stdout);
      if (found?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(found[1]);
    };
    child.stdout.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the Next dev server exited with ${String(code)} before serving.\n` +
            // A build-directory lock lands here, and it must be loud: see the
            // file header on why this file cannot share `.next-test` with the
            // Playwright suite.
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
    check();
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    close: async (): Promise<void> => {
      await new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        child.once("exit", () => done());
        child.kill("SIGKILL");
      });
    },
  };
}

/* -------------------------------------------------------------------------
 * Following redirects BY HAND, because the hop count is the finding
 * ---------------------------------------------------------------------- */

interface Hop {
  readonly status: number;
  readonly location: string | null;
  readonly url: string;
}

interface Landed {
  /** Every redirect traversed, in order. `hops` is its length. */
  readonly chain: readonly Hop[];
  readonly hops: number;
  /** True when the cap was hit — i.e. the address does not terminate. */
  readonly looped: boolean;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly bytes: Buffer;
}

/**
 * `redirect: "manual"` in a loop with a hard cap, NOT `fetch`'s own following.
 *
 * A `redirect: "follow"` fetch reports a loop as a bare `TypeError: fetch
 * failed`, which is the same thing it reports for a refused connection — and
 * "your backend is down" for a routing bug in the client is the exact
 * misdiagnosis this route already shipped once. Counting the hops here makes
 * the failure message name the chain.
 */
async function land(url: string, cap = 8): Promise<Landed> {
  const chain: Hop[] = [];
  let current = url;
  for (let i = 0; i <= cap; i += 1) {
    const response = await fetch(current, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      // Drain, or the socket stays open and node's test runner waits on it.
      await response.arrayBuffer();
      chain.push({ status: response.status, location, url: current });
      if (chain.length > cap) {
        return {
          chain,
          hops: chain.length,
          looped: true,
          url: current,
          status: response.status,
          contentType: "",
          body: "",
          bytes: Buffer.alloc(0),
        };
      }
      current = new URL(location, current).toString();
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      chain,
      hops: chain.length,
      looped: false,
      url: current,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: bytes.toString("utf8"),
      bytes,
    };
  }
  /* c8 ignore next */
  throw new Error("unreachable: the loop above returns on every path");
}

/** The chain, rendered for a failure message. */
function describe(landed: Landed): string {
  const hops = landed.chain
    .map((hop) => `  ${String(hop.status)} ${hop.url} -> ${hop.location ?? "(none)"}`)
    .join("\n");
  return (
    `${landed.looped ? "DID NOT TERMINATE" : `final ${String(landed.status)} ${landed.url}`}` +
    ` after ${String(landed.hops)} hop(s)${hops === "" ? "" : `:\n${hops}`}`
  );
}

/* -------------------------------------------------------------------------
 * The harness, booted once for the file
 * ---------------------------------------------------------------------- */

let backend: Backend | null = null;
let client: NextHarness | null = null;

before(async () => {
  backend = await startBackend();
  client = await startNext(backend.origin);
});

after(async () => {
  await client?.close();
  await backend?.close();
});

function origins(): { readonly next: string; readonly api: string; readonly mount: string } {
  assert.ok(backend !== null && client !== null, "the harness did not start");
  return {
    next: client.origin,
    api: backend.origin,
    mount: `/api/runs/${SITE_RUN_ID}/preview`,
  };
}

/* -------------------------------------------------------------------------
 * C1 — the address the owner clicks
 * ---------------------------------------------------------------------- */

test("THE LINK THE OWNER CLICKS: the preview answers in ZERO hops through the client origin", async () => {
  const { next, mount } = origins();

  // THE POSITIVE CONTROL FIRST, so a client that 404s everything cannot satisfy
  // the hop assertion below by never redirecting.
  const direct = await land(`${next}${mount}/`);
  assert.equal(direct.status, 200, describe(direct));
  assert.ok(
    direct.body.includes(INDEX_MARKER),
    `the document did not come through the rewrite: ${describe(direct)}\n${direct.body.slice(0, 300)}`,
  );
  assert.match(direct.contentType, /^text\/html/, describe(direct));

  // ZERO, NOT "TERMINATES EVENTUALLY". Next's trailing-slash canonicalisation
  // strips the slash, the rewrite proxies the slashless form, and the backend
  // 302s the slash back on — a cycle that satisfies any "reaches 200 within N
  // hops" assertion never, and any "does not 500" assertion always.
  assert.equal(direct.hops, 0, `the slash form must not redirect at all: ${describe(direct)}`);
});

test("the no-slash form costs EXACTLY ONE redirect, and it lands on the slash form", async () => {
  const { next, mount } = origins();

  const bare = await land(`${next}${mount}`);
  assert.equal(bare.hops, 1, `expected one redirect and one only: ${describe(bare)}`);
  assert.equal(bare.status, 200, describe(bare));
  assert.ok(bare.body.includes(INDEX_MARKER), describe(bare));
  assert.equal(new URL(bare.url).pathname, `${mount}/`, describe(bare));

  // WHY THE REDIRECT IS KEPT AT ALL, asserted rather than asserted-about: from
  // the slashless address a relative reference resolves one segment too high.
  const wrong = new URL("styles.css", `${next}${mount}`);
  assert.equal(wrong.pathname, `/api/runs/${SITE_RUN_ID}/styles.css`);
  const missed = await land(wrong.toString());
  assert.notEqual(missed.status, 200, `the wrongly-resolved address answered 200: ${describe(missed)}`);
});

/* -------------------------------------------------------------------------
 * C2 — a ROOT-ABSOLUTE document, which is what the owner's builds write
 * ---------------------------------------------------------------------- */

/** Every `href`/`src`/`poster` in the served document, in source order. */
function references(html: string): readonly string[] {
  return [...html.matchAll(/(?:href|src|poster)="([^"]*)"/g)].map((match) => match[1] ?? "");
}

test("A ROOT-ABSOLUTE DOCUMENT'S STYLESHEET IS A STYLESHEET, not Next's 404 page", async () => {
  const { next, mount } = origins();

  const document = await land(`${next}${mount}/`);
  assert.equal(document.status, 200, describe(document));

  /*
   * THE NEGATIVE CONTROL, AND IT IS THE WHOLE TEST.
   *
   * `/styles.css` at the CLIENT origin is not the backend's honest JSON 404 —
   * it is Next's own HTML error page, 404 with `content-type: text/html`. A
   * browser hands that to the CSS parser, which discards it silently: the page
   * paints in Times New Roman with no console error a reader would notice, and
   * reads as a build that produced nothing. Asserting "not 200" is not enough;
   * the shipped bug WAS a non-200 that no one saw.
   */
  const naive = await land(`${next}/styles.css`);
  assert.ok(
    !(naive.status === 200 && naive.contentType.startsWith("text/css")),
    "the origin root already serves the stylesheet, so this test cannot fail and proves nothing",
  );

  // AND THE POSITIVE HALF: resolve the address the document actually names,
  // exactly as a browser resolves it, and fetch it.
  const href = references(document.body).find((value) => value.endsWith("styles.css"));
  assert.ok(href !== undefined, `no stylesheet in the served document: ${document.body.slice(0, 400)}`);
  const resolved = new URL(href, document.url);
  assert.ok(
    resolved.pathname.startsWith(`${mount}/`),
    `the stylesheet resolves OUTSIDE the preview, to ${resolved.pathname} — ` +
      "which is the unstyled page, and it is reached without a single failed request",
  );

  const css = await land(resolved.toString());
  assert.equal(css.status, 200, `the stylesheet the document names: ${describe(css)}`);
  assert.match(css.contentType, /^text\/css/, `${resolved.pathname} came back as ${css.contentType}`);
  assert.ok(css.body.includes(CSS_MARKER), "something answered 200 text/css and it was not the stylesheet");
});

test("the script, the image and a PERCENT-ENCODED poster resolve inside the preview too", async () => {
  const { next, mount } = origins();
  const document = await land(`${next}${mount}/`);
  const named = references(document.body);

  const script = named.find((value) => value.endsWith("main.js"));
  assert.ok(script !== undefined, "no script in the served document");
  const scriptFetch = await land(new URL(script, document.url).toString());
  assert.equal(scriptFetch.status, 200, describe(scriptFetch));
  assert.match(scriptFetch.contentType, /^text\/javascript/, scriptFetch.contentType);
  assert.ok(scriptFetch.body.includes(JS_MARKER));

  // THE ENCODED ONE. `:path*` re-encodes per segment and `:path(.*)` passes the
  // remainder whole, so a filename with a space is the case a change to the
  // rewrite source breaks first and silently.
  const poster = named.find((value) => value.includes("poster"));
  assert.ok(poster !== undefined, "no poster in the served document");
  const posterFetch = await land(new URL(poster, document.url).toString());
  assert.equal(posterFetch.status, 200, `${poster}: ${describe(posterFetch)}`);
  assert.equal(posterFetch.contentType, "image/png");
  assert.ok(posterFetch.bytes.equals(PNG_BYTES), "the image bytes were altered on the way out");

  // THE RELATIVE REFERENCE IS UNTOUCHED AND STILL WORKS, which is the control
  // that says the fix re-points the root-absolute ones rather than rewriting
  // every attribute it can see.
  assert.ok(
    named.includes("assets/hero.png"),
    `a relative reference was rewritten; the document names: ${named.join(" ")}`,
  );
  const relative = await land(new URL("assets/hero.png", document.url).toString());
  assert.equal(relative.status, 200, describe(relative));

  // AND THE OFF-SITE ONES ARE LEFT ALONE. Re-pointing these at the preview
  // would turn a working CDN reference into a 404 inside the workspace.
  assert.ok(named.includes("https://example.com/vendor.css"), named.join(" "));
  assert.ok(named.includes("//example.com/vendor.js"), named.join(" "));
  assert.ok(named.includes("#top"), named.join(" "));
  assert.ok(named.includes("mailto:someone@example.com"), named.join(" "));
});

test("root-absolute `url()` inside CSS resolves too — in the document's inline style AND in the stylesheet", async () => {
  const { next, mount } = origins();

  const document = await land(`${next}${mount}/`);
  const inline = /url\(([^)]*)\)/.exec(document.body);
  assert.ok(inline !== null, "the inline <style> block did not survive to the wire");
  const inlineUrl = new URL((inline[1] ?? "").replace(/^['"]|['"]$/g, ""), document.url);
  assert.ok(
    inlineUrl.pathname.startsWith(`${mount}/`),
    `an inline url() still points at the origin root: ${inlineUrl.pathname}`,
  );
  assert.equal((await land(inlineUrl.toString())).status, 200, inlineUrl.pathname);

  const css = await land(`${next}${mount}/styles.css`);
  assert.equal(css.status, 200, describe(css));
  const external = /url\(([^)]*)\)/.exec(css.body);
  assert.ok(external !== null, "the stylesheet's url() did not survive to the wire");
  const externalUrl = new URL((external[1] ?? "").replace(/^['"]|['"]$/g, ""), `${next}${mount}/styles.css`);
  assert.ok(
    externalUrl.pathname.startsWith(`${mount}/`),
    `a stylesheet url() still points at the origin root: ${externalUrl.pathname}`,
  );
  assert.equal((await land(externalUrl.toString())).status, 200, externalUrl.pathname);
});

/* -------------------------------------------------------------------------
 * The rest of the API has to survive the rewrite that fixes the preview
 * ---------------------------------------------------------------------- */

test("the rewrite still carries the ordinary API: a JSON route, and a refusal that keeps its status", async () => {
  const { next } = origins();

  const health = await land(`${next}/api/health`);
  assert.equal(health.status, 200, describe(health));
  assert.match(health.contentType, /^application\/json/, health.contentType);

  const runs = await land(`${next}/api/runs`);
  assert.equal(runs.status, 200, describe(runs));
  assert.ok(runs.body.includes(SITE_RUN_ID), "the run list came back without the run");

  // A refusal must arrive as the refusal, not as a proxy error and not as
  // Next's own 404 page: the preview card reads the CODE out of this body.
  const unknown = await land(`${next}/api/runs/run-does-not-exist/preview/`);
  assert.equal(unknown.status, 404, describe(unknown));
  assert.match(unknown.contentType, /^application\/json/, unknown.contentType);
  assert.equal((JSON.parse(unknown.body) as { error: string }).error, "unknown_run");
});

/**
 * The SSE stream, and TWO events rather than one, because of something this test
 * measured the hard way.
 *
 * AN SSE RESPONSE HERE SENDS NOTHING — NOT EVEN ITS HEADERS — UNTIL THE FIRST
 * WRITE. `attachSse` calls `writeHead` and no `flushHeaders`, and node holds the
 * header block until a body write joins it. On a run with no stored events that
 * means the client sits blind until the 15 s heartbeat. The first draft of this
 * test emitted its event from inside the response callback and deadlocked on
 * exactly that: the callback waited for headers, the headers waited for a write,
 * and the write waited for the callback. It reported
 *
 *   Error: no event reached the reader within 10s through http://127.0.0.1:55570;
 *   the stream carried ""
 *
 * and an earlier `fetch` version passed at 15 011 / 15 006 / 15 012 ms — which
 * read as "the proxy is buffering the body" and is not: it was the header wait.
 * Measured with the same backend and the same Next child, primed:
 *
 *   direct, node:http       event delivered in 1 ms
 *   through Next, node:http event delivered in 1 ms
 *   direct, undici fetch    event delivered in 1 ms
 *   through Next, fetch     event delivered in 0 ms
 *
 * So: PRIMER flushes the headers and proves the server has reached `attachSse`
 * and subscribed; the second event is therefore on the LIVE path, not the
 * replay, and its latency is the number this test asserts on. That distinction
 * is the whole value of the assertion — a replay-delivered event would arrive
 * promptly even from a proxy that never forwards a live write.
 */
test("the SSE stream arrives through the rewrite in milliseconds, not at the next heartbeat", async () => {
  const { next } = origins();
  assert.ok(backend !== null);
  const bus = backend.bus;
  const primer = "SSE_PRIMER_THROUGH_NEXT";
  const marker = "SSE_LIVE_THROUGH_NEXT";

  const delivered = await new Promise<{ status: number; contentType: string; ms: number }>(
    (resolve, reject) => {
      let seen = "";
      let emittedAt = 0;
      const request = get(`${next}/api/runs/${SITE_RUN_ID}/events`, (response) => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers["content-type"] ?? "";
        response.setEncoding("utf8");
        // ACCUMULATED, NOT TESTED PER CHUNK: a frame can be split across TCP
        // reads, and a per-chunk `includes` would wait forever for a marker
        // that had already arrived in two halves.
        response.on("data", (chunk: string) => {
          seen += chunk;
          if (seen.includes(primer) && emittedAt === 0) {
            emittedAt = Date.now();
            bus.emit(SITE_RUN_ID, { type: "log", level: "info", text: marker });
            return;
          }
          if (!seen.includes(marker)) return;
          request.destroy();
          resolve({ status, contentType, ms: Date.now() - emittedAt });
        });
      });
      request.on("error", (error) => {
        // `destroy()` above surfaces here after `resolve`; a settled promise
        // ignores it, and a real connection failure still rejects.
        reject(error);
      });
      // Late enough that the request has reached `attachSse` and subscribed;
      // this write is what flushes the response headers.
      setTimeout(() => bus.emit(SITE_RUN_ID, { type: "log", level: "info", text: primer }), 300);
      setTimeout(() => {
        request.destroy();
        reject(
          new Error(
            `no live event reached the reader within 10s through ${next}; ` +
              `the stream carried ${JSON.stringify(seen.slice(0, 400))}`,
          ),
        );
      }, 10_000).unref();
    },
  );

  assert.equal(delivered.status, 200);
  assert.match(delivered.contentType, /text\/event-stream/);
  // WELL UNDER `HEARTBEAT_MS` (15 000), which is the number that discriminates:
  // a proxy that buffered the body would deliver this event when the heartbeat
  // flushed it and would look identical to a working stream to any assertion
  // that only asked whether it arrived at all.
  assert.ok(
    delivered.ms < 5_000,
    `the live event took ${String(delivered.ms)} ms to cross the rewrite; ` +
      "at or near 15 000 ms it is arriving with the heartbeat, i.e. the body is being buffered",
  );
});
