/**
 * preview-route.test.ts — `GET /api/runs/:id/preview/*`, over a real loopback
 * server, with a real workspace on disk and the sealed suite three levels above
 * it.
 *
 * WHAT THIS ROUTE IS FOR, because it decides what the tests have to prove.
 * `RunDetail.previewUrl` is a DEAD ADDRESS: it is the `http://127.0.0.1:<port>`
 * a `deploy: true` run served its own workspace on, and the process that answered
 * it exited with the run (measured: `http://127.0.0.1:4321`, nothing listening,
 * artefact intact on disk). The preview therefore has to come from the dashboard,
 * which is running whenever anyone is looking at it. So the positive controls
 * here are not decoration — a route that refused everything would satisfy every
 * refusal below, and the owner's actual ask is to SEE THE SITE.
 *
 * THE GEOMETRY IS THE POINT OF THE FIXTURE, and it is `code-files.test.ts`'s
 * geometry on purpose: the workspace is `<home>/runs/<id>/workspace`, the run's
 * own `results/` is its SIBLING, and `<home>/results/scores` and
 * `<home>/acceptance` are three levels up. All three of those carry held-out test
 * titles, so every escape test asserts not merely a non-200 but that the held-out
 * marker appears NOWHERE in the response bytes. A 500 from an unhandled throw
 * would satisfy "not 200" and prove nothing.
 *
 * SYMLINKS ARE THE DECISIVE CONTAINMENT TESTS, AND THE ENCODED SPELLINGS ARE NOT.
 * `handle()` builds a `new URL(request.url, …)`, and the WHATWG URL parser's
 * double-dot rule normalises `..`, `%2e%2e` and `.%2e` away before any code in
 * this repository sees them — so a test firing those proves "not served" and says
 * nothing about whether the containment check ran. They are kept anyway (a
 * router that stopped normalising must not silently start traversing), but the
 * checks with teeth are the three symlinks, whose realpath lands outside the
 * workspace and which no amount of URL normalisation can help with. Those assert
 * the refusal CODE, not merely the status, so "refused for the wrong reason"
 * — the file simply not existing — fails.
 *
 * WHAT IT DOES NOT COVER. The `Content-Security-Policy` assertion checks that the
 * header is SENT with the directives it claims; nothing here is a browser, so
 * nothing here proves a browser enforces them. And the redirect test asserts URL
 * arithmetic plus a real fetch of the wrongly-resolved address, which is as close
 * to "the page renders unstyled" as a test without a rendering engine gets.
 */

import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiErrorResponse } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { createDashboardServer } from "./http.js";
import type { RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, ensureRunDirs, resolvePaths, runPathsFor } from "./paths.js";

/** The run whose workspace holds a complete little site. */
const SITE_RUN_ID = "run-preview-site";
/** A run that built something and never wrote an entry document. */
const NO_INDEX_RUN_ID = "run-preview-no-index";
/** A run row with no directory on disk at all. */
const NO_WORKSPACE_RUN_ID = "run-preview-no-workspace";

/**
 * The string that must never cross the wire. It stands in for a held-out test
 * title, which is what `<home>/acceptance`, `<home>/results/scores` and the run's
 * own `results/` really hold.
 */
const HELD_OUT_MARKER = "HELD_OUT_TITLE:the booking modal closes on Escape";

const INDEX_MARKER = "PREVIEW_INDEX_MARKER:the workshop hero";
const CSS_MARKER = "PREVIEW_CSS_MARKER";
const JS_MARKER = "PREVIEW_JS_MARKER";
const DOCS_MARKER = "PREVIEW_DOCS_MARKER";

/** Matches `ANTHROPIC_KEY_SHAPE` in `bakeoff/src/redact.ts`. Not a real key. */
const LEAKED_KEY = "sk-ant-api03-Zq9WfTb2Kx4Lm8Np1Qr7Sv3Uw6Yz0Ab5Cd8Ef2Gh4Ij6Kl";

/** A PNG signature plus a few bytes. Enough to compare byte-for-byte. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x49, 0x48]);

interface Harness {
  readonly base: string;
  readonly paths: DashboardPaths;
  readonly workspace: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-preview-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  // SEALED, AND THREE LEVELS ABOVE THE WORKSPACE.
  writeFileSync(join(paths.acceptance, "held-out-titles.md"), `# suite\n\n- ${HELD_OUT_MARKER}\n`, "utf8");
  mkdirSync(join(paths.results, "scores"), { recursive: true });
  writeFileSync(
    join(paths.results, "scores", "run.json"),
    JSON.stringify({ titles: [HELD_OUT_MARKER] }, null, 2),
    "utf8",
  );

  const runPaths = runPathsFor(paths, SITE_RUN_ID);
  ensureRunDirs(runPaths);
  const workspace = runPaths.workspace;

  // THE RUN'S OWN `results/`, which is the workspace's SIBLING and holds the
  // scorer's output. Real content, so the symlink test below reaches a file that
  // EXISTS — a symlink to a missing file would be refused as `not_found` and
  // would prove nothing about containment.
  writeFileSync(join(runPaths.results, "held-out.json"), JSON.stringify({ titles: [HELD_OUT_MARKER] }), "utf8");

  // The site itself. `index.html` links its assets RELATIVELY, which is the whole
  // reason the trailing-slash redirect exists.
  writeFileSync(
    join(workspace, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>` +
      `<body><h1>${INDEX_MARKER}</h1><img src="assets/hero.png"><script src="script.js"></script></body></html>\n`,
    "utf8",
  );
  writeFileSync(join(workspace, "styles.css"), `body { color: #111 } /* ${CSS_MARKER} */\n`, "utf8");
  writeFileSync(join(workspace, "script.js"), `console.log("${JS_MARKER}");\n`, "utf8");
  mkdirSync(join(workspace, "assets"), { recursive: true });
  writeFileSync(join(workspace, "assets", "hero.png"), PNG_BYTES);
  // An extension the content-type table has never heard of.
  writeFileSync(join(workspace, "notes.weirdext"), "not a web type\n", "utf8");

  // A nested document root, for the sub-directory index.
  mkdirSync(join(workspace, "docs"), { recursive: true });
  writeFileSync(join(workspace, "docs", "index.html"), `<h1>${DOCS_MARKER}</h1>\n`, "utf8");

  // A credential store the builder committed. Refused by NAME on both routes.
  writeFileSync(join(workspace, ".env"), `ANTHROPIC_API_KEY=${LEAKED_KEY}\n`, "utf8");

  // THE THREE ESCAPES, all inside the workspace by spelling and outside it by
  // realpath. These are what the containment check exists for.
  symlinkSync(join(paths.acceptance, "held-out-titles.md"), join(workspace, "escape.txt"));
  symlinkSync(runPaths.results, join(workspace, "leak-results"));
  symlinkSync(join(paths.results, "scores", "run.json"), join(workspace, "leak-scores"));

  // A run that built HTML under another name and no `index.html`.
  const noIndex = runPathsFor(paths, NO_INDEX_RUN_ID);
  ensureRunDirs(noIndex);
  writeFileSync(join(noIndex.workspace, "about.html"), "<h1>about</h1>\n", "utf8");
  writeFileSync(join(noIndex.workspace, "styles.css"), "body{}\n", "utf8");

  // NO `ensureRunDirs` FOR THE THIRD RUN, deliberately: the row exists and the
  // directory does not, which is what a run cancelled before its build segment
  // looks like.

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  for (const runId of [SITE_RUN_ID, NO_INDEX_RUN_ID, NO_WORKSPACE_RUN_ID]) {
    store.createRun({
      runId,
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
  }

  // Never invoked: no test here touches /api/health or /api/models. The real
  // classes are constructed rather than mocked so this file exercises the same
  // router wiring `index.ts` builds.
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
    base: `http://127.0.0.1:${String(address.port)}`,
    paths,
    workspace,
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

interface Fetched {
  readonly status: number;
  readonly contentType: string;
  readonly location: string | null;
  readonly raw: string;
  readonly bytes: Buffer;
  readonly headers: Headers;
}

/**
 * One preview request. `redirect: "manual"` ALWAYS, so a redirect is something a
 * test asserts rather than something it silently rides through — the redirect is
 * a behaviour here, not plumbing.
 */
async function preview(harness: Harness, suffix: string, runId: string = SITE_RUN_ID): Promise<Fetched> {
  return await raw(`${harness.base}/api/runs/${runId}/preview${suffix}`);
}

async function raw(url: string): Promise<Fetched> {
  const response = await fetch(url, { redirect: "manual" });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    location: response.headers.get("location"),
    raw: bytes.toString("utf8"),
    bytes,
    headers: response.headers,
  };
}

/**
 * The refusal body, or a failure that says what actually came back.
 *
 * A BARE `JSON.parse` HERE WOULD MASK THE FAILURE THIS FILE EXISTS TO CATCH. If a
 * regression made a refusal path answer 200 with a file's bytes, `JSON.parse`
 * would throw `SyntaxError: Unexpected token <` and the red output would read as
 * a broken test rather than as "the fence let a stylesheet through". Every
 * refusal in this API is `sendError`'s JSON, so a non-JSON body IS the finding.
 */
function errorBody(fetched: Fetched): ApiErrorResponse {
  try {
    return JSON.parse(fetched.raw) as ApiErrorResponse;
  } catch {
    assert.fail(
      `expected a JSON refusal body and got ${String(fetched.status)} ` +
        `${fetched.contentType}: ${fetched.raw.slice(0, 300)}`,
    );
  }
}

/* -------------------------------------------------------------------------
 * The fixture, before anything is asserted about it
 * ---------------------------------------------------------------------- */

test("the three files that must not leak really do contain the marker", async () => {
  // WITHOUT THIS, EVERY LEAK ASSERTION BELOW PASSES TRIVIALLY. `!raw.includes(
  // HELD_OUT_MARKER)` is true of an empty file, a mis-joined fixture path and a
  // marker that was renamed on one side only — so the escape tests would go green
  // with the fence deleted. This is the negative control for the controls.
  const harness = await startHarness();
  try {
    for (const path of [
      join(harness.paths.acceptance, "held-out-titles.md"),
      join(harness.paths.results, "scores", "run.json"),
      join(runPathsFor(harness.paths, SITE_RUN_ID).results, "held-out.json"),
    ]) {
      assert.ok(
        readFileSync(path, "utf8").includes(HELD_OUT_MARKER),
        `${path} does not hold the held-out marker, so every leak assertion in this file is vacuous`,
      );
    }
    // And the three symlinks really do point at them from INSIDE the workspace —
    // a broken link would be refused as `not_found` and would prove nothing about
    // containment.
    for (const name of ["escape.txt", "leak-results", "leak-scores"]) {
      assert.ok(
        existsSync(join(harness.workspace, name)),
        `${name} does not resolve: the escape it is supposed to attempt cannot happen`,
      );
    }
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The site is actually served
 * ---------------------------------------------------------------------- */

test("the built site is served BY THE DASHBOARD, which is the point of the route", async () => {
  const harness = await startHarness();
  try {
    const index = await preview(harness, "/");
    assert.equal(index.status, 200, index.raw.slice(0, 300));
    assert.equal(index.contentType, "text/html; charset=utf-8");
    assert.ok(index.raw.includes(INDEX_MARKER), "the workspace's index.html did not reach the wire");

    // THE HEADERS ARE ASSERTED, NOT THEIR ENFORCEMENT. Nothing in this process is
    // a browser. What this catches is the directives being dropped or reworded —
    // `connect-src 'none'` is the one that stops a built page calling this API
    // from the dashboard's own origin, and losing it is invisible without a check.
    const csp = index.headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src 'none'/, "the preview's CSP no longer blocks fetch/XHR back into the API");
    assert.match(csp, /form-action 'none'/, "the preview's CSP no longer blocks a form POST into the API");
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    assert.equal(index.headers.get("cache-control"), "no-store");
  } finally {
    await harness.close();
  }
});

test("the no-slash form redirects, because without it every relative asset resolves OUTSIDE the preview", async () => {
  const harness = await startHarness();
  try {
    const bare = await preview(harness, "");
    assert.equal(bare.status, 302, `expected a redirect, got ${String(bare.status)}: ${bare.raw.slice(0, 200)}`);
    assert.equal(bare.location, `/api/runs/${SITE_RUN_ID}/preview/`);

    // THE NEGATIVE CONTROL, AND IT IS THE REASON THE REDIRECT EXISTS. A document
    // served at `…/preview` resolves its own `styles.css` against `…/`, which is
    // `/api/runs/:id/` — a different route entirely. Asserting the arithmetic
    // AND fetching the address proves the failure is real rather than argued.
    const wrong = new URL("styles.css", `${harness.base}/api/runs/${SITE_RUN_ID}/preview`);
    assert.equal(wrong.pathname, `/api/runs/${SITE_RUN_ID}/styles.css`);
    const wrongFetch = await raw(wrong.toString());
    assert.notEqual(wrongFetch.status, 200, "the wrongly-resolved asset address answered 200, so this test proves nothing");
    assert.ok(!wrongFetch.raw.includes(CSS_MARKER), "the stylesheet is reachable off the preview root");

    // AND THE POSITIVE HALF: from the redirected location, the same relative
    // reference lands on the file.
    const right = new URL("styles.css", `${harness.base}${bare.location ?? ""}`);
    assert.equal(right.pathname, `/api/runs/${SITE_RUN_ID}/preview/styles.css`);
    const rightFetch = await raw(right.toString());
    assert.equal(rightFetch.status, 200);
    assert.ok(rightFetch.raw.includes(CSS_MARKER));
  } finally {
    await harness.close();
  }
});

test("assets come back with the content type that makes a browser load them", async () => {
  const harness = await startHarness();
  try {
    const css = await preview(harness, "/styles.css");
    assert.equal(css.status, 200);
    assert.equal(css.contentType, "text/css; charset=utf-8");
    assert.ok(css.raw.includes(CSS_MARKER));

    const js = await preview(harness, "/script.js");
    assert.equal(js.status, 200);
    assert.equal(js.contentType, "text/javascript; charset=utf-8");
    assert.ok(js.raw.includes(JS_MARKER));

    const png = await preview(harness, "/assets/hero.png");
    assert.equal(png.status, 200);
    assert.equal(png.contentType, "image/png");
    assert.ok(png.bytes.equals(PNG_BYTES), "the image bytes were altered on the way out");

    // THE FALLBACK IS REAL AND HAS A COST. Paired with `nosniff` this DOWNLOADS
    // rather than renders; the fix for a genuinely missing type is to add it to
    // `STATIC_CONTENT_TYPES`, which is `bakeoff`'s table and the scorer's too.
    const unknown = await preview(harness, "/notes.weirdext");
    assert.equal(unknown.status, 200);
    assert.equal(unknown.contentType, "application/octet-stream");
  } finally {
    await harness.close();
  }
});

test("a nested directory serves its own index.html, after the same redirect", async () => {
  const harness = await startHarness();
  try {
    const bare = await preview(harness, "/docs");
    assert.equal(bare.status, 302);
    assert.equal(bare.location, `/api/runs/${SITE_RUN_ID}/preview/docs/`);

    const docs = await preview(harness, "/docs/");
    assert.equal(docs.status, 200, docs.raw.slice(0, 300));
    assert.equal(docs.contentType, "text/html; charset=utf-8");
    assert.ok(docs.raw.includes(DOCS_MARKER));
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The fence
 * ---------------------------------------------------------------------- */

test("THE HELD-OUT BOUNDARY: a symlink out of the workspace is refused by the preview too", async () => {
  const harness = await startHarness();
  try {
    // POSITIVE CONTROL FIRST. Without it every refusal below is satisfied by a
    // route that serves nothing at all.
    const ok = await preview(harness, "/styles.css");
    assert.equal(ok.status, 200);
    assert.ok(ok.raw.includes(CSS_MARKER));

    // THE CHECK WITH TEETH: the target EXISTS, so realpath succeeds and the
    // refusal can only come from the containment comparison. Asserting the code
    // is what separates "refused" from "the file happened not to be there".
    const escape = await preview(harness, "/escape.txt");
    assert.ok(!escape.raw.includes(HELD_OUT_MARKER), `escape.txt leaked a held-out title: ${escape.raw.slice(0, 300)}`);
    assert.equal(escape.status, 403, `escape.txt answered ${String(escape.status)}`);
    assert.equal(errorBody(escape).error, "path_escapes_workspace");

    /*
     * THE SPELLINGS, AND AN HONEST NOTE ABOUT WHAT THEY PROVE.
     *
     * `handle()` parses `request.url` with `new URL`, and the WHATWG parser's
     * double-dot rule eats `..`, `%2e%2e` and `.%2e` before any code here runs —
     * so those spellings never reach the containment check and this loop asserts
     * ONLY that they are not served. The double-encoded form is the one with a
     * real mechanism behind it: it must be decoded EXACTLY ONCE, arriving as a
     * literal segment named `%2e%2e` that does not exist. A second decode
     * anywhere in the chain turns it into a traversal.
     */
    for (const suffix of [
      "/%2e%2e/%2e%2e/%2e%2e/acceptance/held-out-titles.md",
      "/%252e%252e/%252e%252e/%252e%252e/acceptance/held-out-titles.md",
      "/%5c..%5c..%5c..%5cacceptance%5cheld-out-titles.md",
      "/.%2e/%2e%2e/%2e%2e/acceptance/held-out-titles.md",
    ]) {
      const attempt = await preview(harness, suffix);
      assert.ok(
        !attempt.raw.includes(HELD_OUT_MARKER),
        `${suffix} leaked a held-out title: ${attempt.raw.slice(0, 300)}`,
      );
      assert.notEqual(attempt.status, 200, `${suffix} must not be served`);
      // A 500 would also satisfy "not 200" and would prove nothing about any
      // check, so the status is pinned to the deliberate refusals.
      assert.ok(
        [400, 403, 404].includes(attempt.status),
        `${suffix} answered ${String(attempt.status)}; expected a deliberate refusal, not a crash`,
      );
    }
  } finally {
    await harness.close();
  }
});

test("`results/` IS NOT REACHABLE through the preview, and the fence is what stops it", async () => {
  const harness = await startHarness();
  try {
    // POSITIVE CONTROL: the site itself is still served.
    const site = await preview(harness, "/");
    assert.equal(site.status, 200);
    assert.ok(site.raw.includes(INDEX_MARKER));

    /*
     * THREE ADDRESSES FOR TWO `results/` DIRECTORIES, all through symlinks whose
     * targets exist, so each refusal is the containment check firing rather than
     * an absent file.
     *
     * There is no name-based rule refusing "results" anywhere in this change, and
     * there deliberately is not one: `runs/<id>/results/` is the workspace's
     * SIBLING and `<home>/results/` is three levels up, so the workspace-only
     * fence already excludes both — and an enumeration of directories to hide is
     * a list somebody forgets to extend.
     *
     * SO THE EXPECTED REFUSAL IS REALPATH CONTAINMENT, NOT THE NAME RULE, and the
     * code is asserted for that reason. `leak-results` and `leak-scores` match
     * nothing in `SECRET_NAME_RULES`; renaming either fixture to something that
     * DOES — `secrets-link`, say — would keep this test green while proving
     * nothing about the fence, which is the substitution the code assertion makes
     * visible.
     */
    for (const suffix of ["/leak-results/held-out.json", "/leak-results/", "/leak-scores"]) {
      const attempt = await preview(harness, suffix);
      assert.ok(
        !attempt.raw.includes(HELD_OUT_MARKER),
        `${suffix} leaked a held-out title: ${attempt.raw.slice(0, 300)}`,
      );
      assert.equal(attempt.status, 403, `${suffix} answered ${String(attempt.status)}`);
      assert.equal(errorBody(attempt).error, "path_escapes_workspace", suffix);
    }
  } finally {
    await harness.close();
  }
});

test("a credential file is refused by the preview exactly as by the code browser", async () => {
  const harness = await startHarness();
  try {
    const env = await preview(harness, "/.env");
    assert.equal(env.status, 403);
    assert.equal(errorBody(env).error, "path_forbidden");
    assert.ok(!env.raw.includes(LEAKED_KEY), ".env leaked a key through the preview");

    // POSITIVE CONTROL: an ordinary file at the same depth is served. The
    // preview does NOT redact its bytes — see `code-files.ts` note 5 — so the
    // name rule is the control that has to hold here, and this pair is what says
    // it holds without the route having simply stopped serving.
    const ok = await preview(harness, "/script.js");
    assert.equal(ok.status, 200);
    assert.ok(ok.raw.includes(JS_MARKER));
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The refusals that have to be legible
 * ---------------------------------------------------------------------- */

test("a build with no index.html gets a NAMED refusal that says what it did find", async () => {
  const harness = await startHarness();
  try {
    const missing = await preview(harness, "/", NO_INDEX_RUN_ID);
    // NOT a 404 and NOT a blank 200: a white page is what a broken build looks
    // like, so the one answer that must never happen is the one that cannot be
    // told from success.
    assert.equal(missing.status, 409, `expected the named refusal, got ${String(missing.status)}`);
    const body = errorBody(missing);
    assert.equal(body.error, "no_index_html");
    assert.match(body.message, /index\.html/);
    // THE ACTIONABLE HALF. `about.html` exists, so the build ran and named its
    // entry point something else — which is a one-line fix, and a bare
    // "no index.html" does not distinguish it from a build that wrote nothing.
    assert.match(body.remediation ?? "", /about\.html/);

    // POSITIVE CONTROL: the run that DID write one is served, so this refusal is
    // about the workspace rather than about the route being broken.
    const site = await preview(harness, "/");
    assert.equal(site.status, 200);
    assert.ok(site.raw.includes(INDEX_MARKER));
  } finally {
    await harness.close();
  }
});

test("a run with no workspace, and a run that does not exist, are told apart", async () => {
  const harness = await startHarness();
  try {
    const none = await preview(harness, "/", NO_WORKSPACE_RUN_ID);
    assert.equal(none.status, 404);
    assert.equal(errorBody(none).error, "no_workspace");

    const unknown = await preview(harness, "/", "run-does-not-exist");
    assert.equal(unknown.status, 404);
    assert.equal(errorBody(unknown).error, "unknown_run");
  } finally {
    await harness.close();
  }
});

test("a missing asset is a 404 and is NOT quietly rewritten to index.html", async () => {
  const harness = await startHarness();
  try {
    const missing = await preview(harness, "/nope.css");
    assert.equal(missing.status, 404);
    assert.equal(errorBody(missing).error, "not_found");
    // NO SPA FALLBACK, for the reason `bakeoff/src/tier0.ts` gives about the
    // scorer's own static server: rewriting every miss to the index makes a site
    // with three broken pages look exactly like a site with three working ones.
    assert.ok(!missing.raw.includes(INDEX_MARKER), "a missing asset was answered with the index document");
  } finally {
    await harness.close();
  }
});
