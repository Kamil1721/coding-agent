/**
 * api-attachments.test.ts — the two routes that let the owner SEE what he
 * attached, and the four refusals that keep them from serving anything else.
 *
 * WHAT THIS FILE IS FOR. Before these routes existed, a PNG and a PDF pasted
 * into the ticket form rendered as bare text chips and
 * `document.querySelectorAll('img')` returned zero elements: the bytes were on
 * disk under `runs/<id>/references/` and `runs/<id>/documents/`, recorded as
 * ABSOLUTE HOST PATHS, and nothing served them. The acceptance condition is a
 * real run with a CV and a design board attached, both visible in the dashboard,
 * so the happy paths below fetch the URL that `RunDetail` advertised and assert
 * the bytes come back — not that a handler exists.
 *
 * THE REFUSALS DO NOT ALL HAVE THE SAME NEGATIVE CONTROL, AND SAYING SO IS THE
 * POINT. `run-attachments.ts` refuses in four ways — filename allowlist,
 * manifest membership, realpath containment, regular-file — and each test below
 * names the mutation that actually reddens IT.
 *
 * THEY ARE NOT INDEPENDENTLY SUFFICIENT, and this header said they were until
 * 2026-08-02 ("any one of them alone is sufficient, so deleting one leaves every
 * HTTP-level test green"). The controls recorded further down this same file
 * disprove it: deleting MEMBERSHIP serves `references.json` — the manifest, with
 * its host paths and digests — over HTTP with a 200, and deleting CONTAINMENT
 * serves a planted symlink's bait with a 200. Both are HTTP-level tests in this
 * file, and both go red. The pair is what makes the route safe; the allowlist is
 * defence in depth and the regular-file check is a guard with no mutation test
 * at all. `run-attachments.ts`'s own header now carries the full breakdown.
 *
 * The allowlist is tested by direct call because through HTTP it is
 * unobservable: the WHATWG URL parser in `http.ts` collapses literal and
 * `%2e%2e` traversal segments before any handler runs.
 *
 * A TRIMMED HARNESS, COPIED FROM `api-references.test.ts` RATHER THAN SHARED.
 * Same argument that file makes: the orchestrator and the site capture are
 * stubbed so no subprocess is spawned, no quota is spent and no browser is
 * launched. Every assertion here is about the ROUTES.
 */

import { strict as assert } from "node:assert";
import {
  chmodSync,
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
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import type { ApiErrorResponse, CreateRunResponse, RunDetail } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import { RunStore } from "./db.js";
import { GateProbe } from "./health-gate.js";
import { READY_GATE_READINESS } from "./gate-readiness-fixture.js";
import { LOOPBACK_HOST, createDashboardServer } from "./http.js";
import type { HttpDeps, RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import { isSafeAttachmentFile, listAttachments, resolveAttachment } from "./run-attachments.js";
import { documentDirFor, referenceDirFor } from "./ticket-refs.js";

const FAKE_MODELS: readonly ModelInfo[] = [
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
];

interface Harness {
  readonly base: string;
  readonly paths: DashboardPaths;
  /** The temp root. Used to plant a file the routes must never reach. */
  readonly dir: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-attach-"));
  const paths = resolvePaths({ DASHBOARD_HOME: join(dir, "home") });
  ensureDirs(paths);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  // A logged-in Claude stub: the catalog emits no model rows without one, and
  // every submission below would 409 `model_unavailable` before writing a byte.
  const claudeBin = join(dir, "claude-stub");
  writeFileSync(claudeBin, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n', "utf8");
  chmodSync(claudeBin, 0o755);
  const auth = new AuthProbe({ claudeBin, codexBin: join(dir, "nope"), env: process.env });
  const catalog = new ModelCatalog(auth, {}, async () => FAKE_MODELS);
  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: () => false,
    resume: () => false,
    pushLiveMessage: () => false,
  };

  const deps: HttpDeps = {
    store,
    bus,
    orchestrator,
    catalog,
    auth,
    paths,
    gate: new GateProbe({ paths, makeGate: () => Promise.reject(new Error("no docker in a routing test")) }),
    gateReadiness: READY_GATE_READINESS,
    // Never launched: no ticket below names a URL, and the stub refuses so a
    // ticket that accidentally did would fail loudly rather than reach chromium.
    captureSite: () => Promise.resolve({ ok: false, reason: "no capture in a routing test" }),
  };
  const server = createDashboardServer(deps);
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    paths,
    dir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function submit(harness: Harness, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${harness.base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: "opus[1m]", ...body }),
  });
  const parsed = (await response.json()) as CreateRunResponse & { message?: string };
  assert.equal(response.status, 201, parsed.message ?? "");
  return parsed.runId;
}

async function detailOf(harness: Harness, runId: string): Promise<RunDetail> {
  const response = await fetch(`${harness.base}/api/runs/${runId}`);
  assert.equal(response.status, 200);
  return (await response.json()) as RunDetail;
}

function pngDataUrl(seed: string, bytes = 32): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, seed.charCodeAt(0)).toString("base64")}`;
}

function imageDataUrl(declared: string, seed: string, bytes = 16): string {
  return `data:image/${declared};base64,${Buffer.alloc(bytes, seed.charCodeAt(0)).toString("base64")}`;
}

function docDataUrl(mediaType: string, text: string): string {
  return `data:${mediaType};base64,${Buffer.from(text, "utf8").toString("base64")}`;
}

/* -------------------------------------------------------------------------
 * The happy paths — the acceptance condition, end to end
 * ---------------------------------------------------------------------- */

test("a reference image attached to a ticket comes back on RunDetail and is fetchable at its own URL", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). In `run-attachments.ts`,
   * `attachmentUrl` was changed to drop the kind segment
   * (`/api/runs/${runId}/${file}`). The URL then 404s and this test failed on
   * `assert.equal(fetched.status, 200)` — proving the assertion follows the
   * advertised URL rather than a hardcoded one.
   *
   * SECOND NEGATIVE CONTROL, for the rendering assertions (applied, watched,
   * restored). `rendersInline` was narrowed to
   * `return contentType === "application/pdf"`. The `inline` assertion below
   * went red while the PDF test stayed green — which is the discrimination that
   * matters, because a design board pushed to the downloads folder fails the
   * acceptance condition just as completely as a 404 does.
   */
  const harness = await startHarness();
  try {
    const runId = await submit(harness, {
      ticketText: "Match this design board",
      references: [pngDataUrl("a", 64)],
    });
    const detail = await detailOf(harness, runId);

    assert.equal(detail.references.length, 1, "the manifest's one image must reach the wire");
    const reference = detail.references[0];
    assert.ok(reference !== undefined);
    assert.equal(reference.file, "reference-1.png");
    assert.equal(reference.bytes, 64, "the size digested at intake, so a page can show it before fetching");
    assert.equal(reference.mediaType, "image/png");
    assert.equal(reference.url, `/api/runs/${runId}/references/reference-1.png`);
    assert.ok(reference.path.endsWith("reference-1.png"), "the builder-facing path survives beside the URL");
    assert.match(reference.sha256, /^[0-9a-f]{64}$/u);

    const fetched = await fetch(`${harness.base}${reference.url}`);
    assert.equal(fetched.status, 200);
    // THE ACCEPTANCE CONDITION IS A DESIGN BOARD THE OWNER SEES, so 200 with the
    // right bytes is not enough on its own: an image typed
    // `application/octet-stream`, or one sent with `attachment`, lands in the
    // downloads folder instead of the page and fails the ask exactly as
    // completely as a 404 would.
    assert.equal(fetched.headers.get("content-type"), "image/png");
    assert.equal(
      fetched.headers.get("content-type"),
      reference.mediaType,
      "the JSON and the response must not describe the same file differently",
    );
    assert.equal(fetched.headers.get("content-disposition"), "inline");
    const body = Buffer.from(await fetched.arrayBuffer());
    assert.equal(body.byteLength, 64, "the bytes, not a JSON description of them");
    assert.deepEqual(body, Buffer.alloc(64, "a".charCodeAt(0)));
  } finally {
    await harness.close();
  }
});

test("every image spelling the intake accepts is typed as an image, so none of them lands in the downloads folder", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). The images branch of
   * `listAttachments` had `previewContentType(file)` replaced with a hardcoded
   * `"image/png"`. The three non-PNG rows below went red on `mediaType` while
   * the PNG happy path above stayed green — which is the discrimination this
   * test exists for and the reason it is not folded into that one.
   *
   * WHY PNG ALONE PROVED NOTHING ABOUT THE OTHER THREE. `previewContentType`
   * answers `application/octet-stream` for any extension missing from the table
   * it imports from `bakeoff`, an octet-stream is not `image/`, so
   * `rendersInline` would send `Content-Disposition: attachment` and the owner's
   * design board would land in the downloads folder instead of the page — the
   * acceptance condition failing with every other test in this file still green.
   *
   * THE FOUR SPELLINGS ARE EXACTLY WHAT `decodeReferenceDataUrl` CAN MINT, with
   * `jpeg` stored as `jpg` by that function's own normalisation. So this also
   * goes red if that regex ever widens past the content-type table.
   */
  const harness = await startHarness();
  try {
    const runId = await submit(harness, {
      ticketText: "Four boards",
      references: [
        imageDataUrl("png", "a"),
        imageDataUrl("jpeg", "b"),
        imageDataUrl("webp", "c"),
        imageDataUrl("gif", "d"),
      ],
    });
    const detail = await detailOf(harness, runId);

    const expected = [
      { file: "reference-1.png", mediaType: "image/png" },
      { file: "reference-2.jpg", mediaType: "image/jpeg" },
      { file: "reference-3.webp", mediaType: "image/webp" },
      { file: "reference-4.gif", mediaType: "image/gif" },
    ];
    assert.equal(detail.references.length, expected.length);
    for (const [index, want] of expected.entries()) {
      const attachment = detail.references[index];
      assert.ok(attachment !== undefined);
      assert.equal(attachment.file, want.file);
      assert.equal(attachment.mediaType, want.mediaType, `${want.file} must be typed as an image`);

      const fetched = await fetch(`${harness.base}${attachment.url}`);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.headers.get("content-type"), want.mediaType);
      assert.equal(
        fetched.headers.get("content-disposition"),
        "inline",
        `${want.file} must render in the page, not download`,
      );
      // Drained so the socket is reusable; an unread body holds the connection
      // open and `server.close()` then waits out the keep-alive timeout.
      await fetched.arrayBuffer();
    }
  } finally {
    await harness.close();
  }
});

test("a PDF document attached to a ticket is served inline, as a PDF, at the URL RunDetail gave", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `attachmentHeaders` in
   * `run-attachments.ts` was changed to hardcode
   * `"Content-Type": "application/octet-stream"`. Two assertions went red: the
   * header check, and the equality between the header and
   * `ApiAttachment.mediaType` — which is the property that stops the JSON and
   * the bytes describing themselves differently.
   */
  const harness = await startHarness();
  try {
    // Not a real PDF; the intake types documents from the data URL's declared
    // media type and never sniffs the bytes (`document-intake.ts` says so).
    const runId = await submit(harness, {
      ticketText: "Here is my CV",
      documents: [docDataUrl("application/pdf", "%PDF-1.7 pretend")],
    });
    const detail = await detailOf(harness, runId);

    assert.equal(detail.documents.length, 1);
    const document = detail.documents[0];
    assert.ok(document !== undefined);
    assert.equal(document.file, "document-1.pdf");
    assert.equal(document.mediaType, "application/pdf");
    assert.equal(document.url, `/api/runs/${runId}/documents/document-1.pdf`);

    const fetched = await fetch(`${harness.base}${document.url}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "application/pdf");
    assert.equal(
      fetched.headers.get("content-type"),
      document.mediaType,
      "the JSON and the response must not describe the same file differently",
    );
    // The acceptance condition is that the owner SEES the CV, not that the
    // browser downloads it.
    assert.equal(fetched.headers.get("content-disposition"), "inline");
    assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
    // No `sandbox` for a PDF: Chrome's viewer is a scripted document. See
    // `attachmentHeaders` for why that is a reasoned trade and not a measured one.
    assert.equal(fetched.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(await fetched.text(), "%PDF-1.7 pretend");
  } finally {
    await harness.close();
  }
});

test("a text document is served as UTF-8 text and as a download, never inline on the dashboard's origin", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `documentContentType` in
   * `run-attachments.ts` was changed to `return mediaType;` (no charset). The
   * `text/plain; charset=utf-8` assertion went red — a browser handed a
   * charset-less text CV falls back to a locale default and renders UTF-8 as
   * mojibake, which is the whole reason that branch exists.
   */
  const harness = await startHarness();
  try {
    const runId = await submit(harness, {
      ticketText: "Scope attached",
      documents: [docDataUrl("text/plain", "Kamil Borzęcki — scope")],
    });
    const detail = await detailOf(harness, runId);
    const document = detail.documents[0];
    assert.ok(document !== undefined);
    assert.equal(document.mediaType, "text/plain; charset=utf-8");

    const fetched = await fetch(`${harness.base}${document.url}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "text/plain; charset=utf-8");
    // A text file rendered on the dashboard's own origin is a document that can
    // reach an API that spends the owner's quota. `nosniff` plus this is the pair.
    assert.equal(fetched.headers.get("content-disposition"), 'attachment; filename="document-1.txt"');
    assert.equal(fetched.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(await fetched.text(), "Kamil Borzęcki — scope");
  } finally {
    await harness.close();
  }
});

test("a run with no attachments reports empty lists, not null and not a missing key", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `listAttachments` was changed
   * to `return [{...}]` for a run with no manifest; both `deepEqual`s went red.
   * The weaker mutation — deleting the `references`/`documents` lines from
   * `toDetail` — is caught by the compiler, which is why this test asserts the
   * VALUE on the wire rather than the field's presence.
   */
  const harness = await startHarness();
  try {
    const runId = await submit(harness, { ticketText: "Just words, no files" });
    const detail = await detailOf(harness, runId);
    assert.deepEqual(detail.references, []);
    assert.deepEqual(detail.documents, []);
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * The refusals
 * ---------------------------------------------------------------------- */

test("the filename allowlist refuses every traversal spelling, by name", () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `SAFE_FILE` in
   * `run-attachments.ts` was loosened to `/^[^/]+$/`; the `..`, `.`,
   * `..%2fetc%2fpasswd`, `.env` and NUL cases went red.
   *
   * TESTED BY DIRECT CALL, NOT OVER HTTP, AND THAT IS DELIBERATE. `new URL()` in
   * `http.ts` normalises literal and `%2e%2e` traversal segments away before any
   * handler sees them, so an HTTP-level test of this guard would pass with the
   * guard deleted. That is a real property of the router and it is pinned
   * separately below — it is not a substitute for the guard.
   */
  for (const hostile of [
    "",
    ".",
    "..",
    "../reference-1.png",
    "..%2f..%2fetc%2fpasswd",
    "%2e%2e%2fpasswd",
    "/etc/passwd",
    "..\\windows\\win.ini",
    "reference-1.png .txt",
    "sub/reference-1.png",
    ".env",
    ".ssh",
  ]) {
    assert.equal(isSafeAttachmentFile(hostile), false, `${JSON.stringify(hostile)} must be refused`);
  }
  // And the names the intake actually mints must survive it, or the route
  // refuses everything and every test above would be measuring nothing.
  for (const minted of ["reference-1.png", "reference-12.webp", "document-1.pdf", "document-4.docx"]) {
    assert.equal(isSafeAttachmentFile(minted), true, `${minted} is a name the intake writes`);
  }
});

test("a traversal reaching the route is answered 404 and serves nothing from outside the run", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `resolveAttachment` was
   * replaced with an unconditional
   * `return { file, realPath: join(dir, decodeURIComponent(file)), contentType:
   * "application/octet-stream", bytes: 0 }`. The first spelling below then
   * returned 200 carrying `SEALED-SUITE-CONTENTS` and this test failed on the
   * LEAK assertion — so it observes "no file from outside the directory reached
   * the wire", rather than only "the server answered something".
   *
   * THE FIRST SPELLING'S DEPTH IS COUNTED, NOT GUESSED, AND AN EARLIER VERSION
   * OF THIS TEST GOT IT WRONG. `references/` sits at
   * `<tmp>/home/runs/<runId>/references`, so reaching `<tmp>/outside.txt` takes
   * FOUR `..` segments. With three the mutant resolved to `<tmp>/home/outside.txt`
   * — a file that does not exist — so the stream errored, the socket was
   * destroyed and the test died on `fetch failed`. Still red, but red for
   * "the server dropped the connection" rather than for "the secret was served",
   * which is not the property this test claims to hold.
   *
   * THE LEAK ASSERTION COMES BEFORE THE STATUS ASSERTION for the same reason:
   * whichever throws first is the one whose message is recorded, and a leak is
   * the finding worth naming.
   */
  const harness = await startHarness();
  try {
    const secret = join(harness.dir, "outside.txt");
    writeFileSync(secret, "SEALED-SUITE-CONTENTS", "utf8");
    const runId = await submit(harness, { ticketText: "Design board", references: [pngDataUrl("a")] });

    for (const spelling of [
      // FOUR segments: the depth that actually reaches `secret`. See the header.
      "..%2f..%2f..%2f..%2foutside.txt",
      "..%2f..%2f..%2foutside.txt",
      "%2e%2e%2foutside.txt",
      "%2f%2f..%2foutside.txt",
      "%00",
      "reference-1.png%00.txt",
      // The literal form, one segment too deep to be popped back into a route.
      // `new URL()` collapses it to `/api/outside.txt`, which no route claims —
      // pinned so a future router change that stops normalising shows up here.
      "../../../outside.txt",
    ]) {
      const response = await fetch(`${harness.base}/api/runs/${runId}/references/${spelling}`);
      const text = await response.text();
      assert.ok(!text.includes("SEALED-SUITE-CONTENTS"), `${spelling} leaked a file outside the run`);
      assert.equal(response.status, 404, `${spelling} must be refused, not served`);
    }

    /*
     * A BARE `..` IS NOT IN THAT LIST BECAUSE IT NEVER REACHES A HANDLER, AND
     * PRETENDING OTHERWISE WOULD BE THE FAKE ASSERTION.
     *
     * `new URL()` pops it, so `…/references/..` IS `…/api/runs/<id>/` — the run
     * detail route, which answers 200 with this run's own JSON. Measured, not
     * assumed: asserting 404 here failed with `200 !== 404`. The property that
     * matters is still checkable and is checked: whatever the parser turns it
     * into, nothing from outside the run comes back.
     */
    const popped = await fetch(`${harness.base}/api/runs/${runId}/references/..`);
    assert.ok(!(await popped.text()).includes("SEALED-SUITE-CONTENTS"));
  } finally {
    await harness.close();
  }
});

test("a symlink inside the run's own directory cannot be followed out of it", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). The containment line in
   * `resolveAttachment` — `if (!real.startsWith(rootReal + sep)) return null;`
   * — was commented out. The request then returned 200 with
   * `SEALED-SUITE-CONTENTS`, failing both assertions. This is the ONLY test here
   * that reddens on that mutation; the traversal test above stays green with it
   * gone, which is why the two are separate.
   *
   * THE SPELLED PATH IS INNOCENT AND THE REAL ONE IS NOT, which is the whole
   * shape of the bug: the manifest still lists `reference-1.png`, the filename
   * still passes the allowlist, `join(dir, file)` is still inside the directory,
   * and only `realpathSync` can tell.
   */
  const harness = await startHarness();
  try {
    const secret = join(harness.dir, "outside.txt");
    writeFileSync(secret, "SEALED-SUITE-CONTENTS", "utf8");
    const runId = await submit(harness, { ticketText: "Design board", references: [pngDataUrl("a")] });

    const planted = join(referenceDirFor(harness.paths.runs, runId), "reference-1.png");
    rmSync(planted);
    symlinkSync(secret, planted);
    // The bait must actually be readable through the symlink, or this test
    // proves nothing about the check.
    assert.equal(readFileSync(planted, "utf8"), "SEALED-SUITE-CONTENTS");

    const response = await fetch(`${harness.base}/api/runs/${runId}/references/reference-1.png`);
    const text = await response.text();
    assert.equal(response.status, 404, "a symlink out of the directory is a miss, not a redirect");
    assert.ok(!text.includes("SEALED-SUITE-CONTENTS"));
  } finally {
    await harness.close();
  }
});

test("a file sitting in the run's directory that the manifest does not list is a 404", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). The manifest lookup in
   * `resolveAttachment` was replaced with
   * `if (!existsSync(join(attachmentDirFor(runsRoot, runId, kind), file))) return null;`
   * — the basename-join shape `serveScreenshot` uses. All three requests below
   * then returned 200, including `references.json`.
   *
   * WHY THE THREE FILES ARE THE ONES THEY ARE. `references.json` is the manifest
   * itself: absolute host paths and digests off the owner's machine, sitting in
   * the directory being served. `capture-1280.png` is what `runCapture` writes
   * when a ticket names a page — the dashboard's reading of someone else's site,
   * not the owner's upload, and conflating the two is what
   * `RunDetail.references` is documented not to do. `dropped.png` is anything
   * else that lands there later.
   */
  const harness = await startHarness();
  try {
    const runId = await submit(harness, { ticketText: "Design board", references: [pngDataUrl("a")] });
    const dir = referenceDirFor(harness.paths.runs, runId);
    writeFileSync(join(dir, "capture-1280.png"), "capture bytes", "utf8");
    writeFileSync(join(dir, "dropped.png"), "not the owner's", "utf8");

    for (const file of ["references.json", "capture-1280.png", "dropped.png"]) {
      const response = await fetch(`${harness.base}/api/runs/${runId}/references/${file}`);
      assert.equal(response.status, 404, `${file} is in the directory but is not an attachment`);
      const parsed = (await response.json()) as ApiErrorResponse;
      assert.equal(parsed.error, "not_found");
    }
    // And it is still absent from the wire, not merely unfetchable.
    const detail = await detailOf(harness, runId);
    assert.deepEqual(
      detail.references.map((reference) => reference.file),
      ["reference-1.png"],
    );
  } finally {
    await harness.close();
  }
});

test("one run cannot reach another run's attachment, and the same name resolves per run", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `attachmentDirFor` in
   * `run-attachments.ts` was changed to drop the per-run segment
   * (`join(runsRoot, kind)`), which is the shape a handler gets when someone
   * "simplifies" the join. This test went red on the second fetch. It reddens
   * the happy paths too — I could not find a mutation that reddens ONLY this
   * one, and say so rather than claiming it isolates run-scoping by itself. What
   * it does add over them is the SECOND assertion: run B's `reference-1.png`
   * must return B's bytes, so a directory that resolved to A's would be caught
   * even while both runs answered 200.
   */
  const harness = await startHarness();
  try {
    const runA = await submit(harness, { ticketText: "Board A", references: [pngDataUrl("a", 64)] });
    const runB = await submit(harness, { ticketText: "Board B", references: [pngDataUrl("b", 32)] });
    const runC = await submit(harness, { ticketText: "No files at all" });

    // A run that attached nothing cannot borrow a sibling's file, even with the
    // right name.
    const borrowed = await fetch(`${harness.base}/api/runs/${runC}/references/reference-1.png`);
    assert.equal(borrowed.status, 404);

    // And two runs with the SAME filename get their own bytes.
    const fromA = Buffer.from(
      await (await fetch(`${harness.base}/api/runs/${runA}/references/reference-1.png`)).arrayBuffer(),
    );
    const fromB = Buffer.from(
      await (await fetch(`${harness.base}/api/runs/${runB}/references/reference-1.png`)).arrayBuffer(),
    );
    assert.deepEqual(fromA, Buffer.alloc(64, "a".charCodeAt(0)));
    assert.deepEqual(fromB, Buffer.alloc(32, "b".charCodeAt(0)));
  } finally {
    await harness.close();
  }
});

test("a run id that does not exist is refused by the dispatcher as unknown_run, before the handler", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). The attachment branch in
   * `http.ts` was moved ABOVE the `row === null` check, which is the ordering
   * mistake this pins: the route then answered its own `not_found` and the
   * `error` assertion went red. The status alone would not have moved — both
   * refusals are 404 by design — which is why this asserts the CODE.
   *
   * WHY THE ORDER MATTERS. Two differently-worded 404s for "no such run" and "no
   * such file" would let a caller separate the two, and separating them is what
   * turns a file route into an existence oracle.
   */
  const harness = await startHarness();
  try {
    for (const kind of ["references", "documents"]) {
      const response = await fetch(`${harness.base}/api/runs/run-does-not-exist/${kind}/document-1.pdf`);
      assert.equal(response.status, 404);
      const parsed = (await response.json()) as ApiErrorResponse;
      assert.equal(parsed.error, "unknown_run", `${kind} must not answer before the run check`);
    }
  } finally {
    await harness.close();
  }
});

test("resolveAttachment refuses a hostile name even when the run really does have attachments", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `resolveAttachment` was
   * changed to return the first listed attachment when the lookup misses
   * (`?? listAttachments(...)[0]`) — a plausible "be helpful" bug. This test went
   * red while `isSafeAttachmentFile`'s own test above stayed green. The pair is
   * deliberate: one tests the predicate, this one tests that the resolver
   * actually calls it and that a miss is a miss.
   *
   * EXACTLY ONE SPELLING BELOW REDDENS IT, AND IT IS `references.json` — measured,
   * because an earlier version of this comment claimed all of them did. With the
   * allowlist still in place the traversal spellings never reach the `??` at all,
   * and `reference-2.png` reaches it but has no bytes on disk for `realpathSync`
   * to find. `references.json` is the only entry that both passes the allowlist
   * AND exists in the directory, which is precisely why it is the one worth
   * listing: it is the manifest, holding absolute host paths and digests off the
   * owner's machine, sitting inside the directory being served.
   *
   * DIRECT CALL, SAME REASON AS THE PREDICATE TEST: the router normalises
   * traversal segments away, so HTTP cannot deliver these strings to the guard.
   */
  const harness = await startHarness();
  try {
    const runId = await submit(harness, { ticketText: "Design board", references: [pngDataUrl("a")] });
    const runs = harness.paths.runs;

    // The control: the honest name resolves, so a blanket `null` would be caught.
    assert.notEqual(resolveAttachment(runs, runId, "references", "reference-1.png"), null);

    for (const hostile of [
      "..",
      "../../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "/etc/passwd",
      "reference-1.png ",
      "references.json",
      "reference-2.png",
    ]) {
      assert.equal(
        resolveAttachment(runs, runId, "references", hostile),
        null,
        `${JSON.stringify(hostile)} must not resolve`,
      );
    }
  } finally {
    await harness.close();
  }
});

test("listAttachments reads the manifest, so the documents directory alone serves nothing", async () => {
  /*
   * NEGATIVE CONTROL (applied, watched, restored). `listAttachments` was changed
   * to fall back to `readdirSync(attachmentDirFor(...))` when the manifest has
   * no entry for the kind. The planted file was then listed AND served, failing
   * both assertions.
   *
   * WHY THIS IS NOT THE SAME TEST AS THE ONE ABOUT UNLISTED FILES. That one
   * plants a file beside a real attachment. This one plants a file where there
   * is NO manifest entry of that kind at all, which is the case a
   * directory-listing implementation gets wrong first: an empty list is exactly
   * where "just read the directory" looks like a harmless improvement.
   */
  const harness = await startHarness();
  try {
    const runId = await submit(harness, { ticketText: "Design board", references: [pngDataUrl("a")] });
    const documents = documentDirFor(harness.paths.runs, runId);
    mkdirSync(documents, { recursive: true });
    writeFileSync(join(documents, "document-1.pdf"), "PLANTED", "utf8");

    assert.deepEqual(listAttachments(harness.paths.runs, runId, "documents"), []);
    const response = await fetch(`${harness.base}/api/runs/${runId}/documents/document-1.pdf`);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes("PLANTED"));
  } finally {
    await harness.close();
  }
});
