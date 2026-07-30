/**
 * Document attachment, asserted ON THE WIRE and against the SERVER'S OWN SOURCE.
 *
 * THE DEFECT THIS FILE EXISTS FOR IS THE ONE `ticket-references.browser.spec.ts`
 * names: a chip list that renders and posts nothing. Every UI assertion — a chip
 * appeared, the filename shows, the tag says PDF — passes perfectly on a control
 * whose file never reaches `POST /api/runs`. And for a document the consequence
 * is the same as for an image and then some: the server folds each document's
 * sha256 into the TICKET ID (`ticketWithReferences`), so a scope that silently
 * fails to attach produces a different ticket id, a different frozen acceptance
 * suite, and a run graded against a brief the owner believes contained their
 * scope. So the load-bearing assertions below read the captured request body.
 *
 * THREE NEGATIVE CONTROLS, EACH FOR A FAILURE THAT LOOKS LIKE SUCCESS ON SCREEN:
 *
 *   1. `documents` must be ABSENT from the body when nothing is attached, not
 *      `[]`. `exactOptionalPropertyTypes` wants the key missing and
 *      `model-picker.browser.spec.ts` asserts whole POST bodies with `toEqual`,
 *      so an unconditional `documents: []` compiles, renders identically, and
 *      turns five unrelated specs red. Only an absence assertion sees it first.
 *   2. A REFUSED TYPE MUST POST NOTHING. A refusal-only assertion passes on a
 *      control that shows the error and attaches the file anyway, so the refusal
 *      and the wire are both checked, in the same test.
 *   3. THE TWO ARRAYS MUST NOT MERGE. `references` and `documents` have separate
 *      decoders, separate caps and separate directories on disk; a PDF arriving
 *      in `references` fails `decodeReferenceDataUrl` and refuses the whole
 *      submission. One test attaches one of each and checks both slots.
 *
 * AND ONE CONTROL THAT IS NOT ABOUT THE BROWSER AT ALL. `src/lib/attachments.ts`
 * TRANSCRIBES its caps and accepted media types from two server modules it cannot
 * import (they pull in `node:fs` at module scope, so they cannot enter a client
 * bundle — `src/lib/graph.ts` explains when a cross-package import IS possible).
 * Nothing in the type system keeps a transcription honest. The parity tests below
 * read `server/src/document-intake.ts` and `server/src/ticket-refs.ts` AS TEXT and
 * fail when a media type, an extension or a cap stops matching — and they assert
 * that their own anchors matched, so a renamed declaration fails as "the
 * declaration moved" rather than silently comparing against an empty list.
 *
 * THOSE PARITY TESTS WERE MUTATED RATHER THAN TRUSTED, 2026-07-30. Five edits
 * were applied to in-memory COPIES of the server sources and the comparisons
 * re-run: a media type ADDED server-side (`application/epub+zip`), a stored
 * extension RENAMED (`msword` → `word`), the `ACCEPTED` declaration RENAMED, the
 * image alternation losing `jpg`, and `MAX_REFERENCE_DOCUMENTS` becoming
 * `Number(process.env.X ?? 4)`. All five turned the check red — the last as "this
 * test cannot evaluate that expression" rather than as a silently wrong number.
 * A parity test that has only ever been observed passing is the defect this
 * repository keeps finding.
 *
 * THE PURE-PLANNER TESTS ARE HERE RATHER THAN IN A `.unit.spec.ts` because the
 * assigned file for this work is one spec, and because they belong beside the
 * wire tests they explain: `planAttachmentIntake` is where every silent drop in
 * this feature would live, and it takes structural objects precisely so it can be
 * exercised without a page. They do not touch `page` at all.
 *
 * WHAT IS NOT COVERED HERE, SAID PLAINLY. The CHAT's document intake
 * (`orchestrator-chat.tsx`) is not exercised in a browser: no spec in this suite
 * mounts the run canvas's chat panel, and the component's document control is
 * refused by default anyway because its caller cannot carry a document (see that
 * file's header). Its refusal path is covered only as the policy test below —
 * that is the planner's behaviour, NOT proof that the component passes the policy
 * in. A test that mounts the chat is the outstanding gap.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import type { ModelOption } from "../src/lib/api-types";
import {
  ACCEPTED_DOCUMENT_TYPES,
  ACCEPTED_IMAGE_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_REFERENCE_DOCUMENTS,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  planAttachmentIntake,
  type Attachment,
  type AttachmentCandidate,
} from "../src/lib/attachments";
import { RUN_DETAIL } from "./fixtures/run-fixture";

const CREATED_RUN = "harness-documents-run";

const MODELS: readonly ModelOption[] = [
  {
    id: "sonnet",
    label: "Sonnet (claude-sonnet-5)",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
];

/**
 * A real, if minimal, PDF: header, one empty page, trailer.
 *
 * THE BYTES DO NOT HAVE TO PARSE for this suite — the API is a stub and nothing
 * here runs `pdftotext` — but a file that is not a PDF at all would make the test
 * a weaker statement than it looks, since the thing under test is the whole path
 * from a picked file to `data:application/pdf;base64,…` on the wire.
 */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);

/** The smallest valid PNG, borrowed from `ticket-references.browser.spec.ts`. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Harness {
  /** Every `POST /api/runs` body, in order. Empty means nothing was submitted. */
  readonly creates: unknown[];
}

/**
 * SERVES ITS OWN API, following `ticket-references`, `model-picker` and
 * `design-lock`: the shared fixture serves the canvas specs, and a form-intake
 * fixture belongs to the file that intakes.
 */
async function serve(page: Page): Promise<Harness> {
  const creates: unknown[] = [];

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/runs" && request.method() === "POST") {
      const raw = request.postData();
      creates.push(raw === null ? null : JSON.parse(raw));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ runId: CREATED_RUN }),
      });
      return;
    }
    if (path === "/api/runs") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (path === "/api/models") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MODELS),
      });
      return;
    }
    if (path === "/api/health") {
      /*
       * `gate` IS SERVED HERE AND IS NOT IN THE NEIGHBOURING FIXTURES. It is
       * REQUIRED on `HealthState`, and `api-types.ts#GateHealth` records that
       * `tests/fixtures/api-server.ts`, `design-lock` and `model-picker` all
       * serve a body without it — a trap for the first renderer to read
       * `health.gate.state`. It is currently defused rather than sprung:
       * `auth-panel.tsx` types its parameter `GateHealth | undefined` and reads
       * `gate?.state` precisely because of those fixtures. A new fixture should
       * still serve the contract, so this one does; the stale three are a
       * handoff, not this change's files.
       */
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          claudeAuth: "ok",
          codexAuth: "missing",
          gate: { state: "ok", detail: "", checkedAt: "2026-07-30T12:00:00.000Z" },
        }),
      });
      return;
    }
    if (path.endsWith("/events")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path.endsWith("/graph")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes: [], edges: [], inventory: null, atSeq: 0 }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...RUN_DETAIL, runId: CREATED_RUN }),
    });
  });

  await page.goto("/");
  await expect(ticketBox(page)).toBeVisible();
  return { creates };
}

const ticketBox = (page: Page) => page.getByRole("textbox").first();

async function typeTicket(page: Page, text: string): Promise<void> {
  await ticketBox(page).click();
  await ticketBox(page).fill(text);
}

interface Upload {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

const pdf = (name: string): Upload => ({ name, mimeType: "application/pdf", buffer: PDF_BYTES });
const png = (name: string): Upload => ({ name, mimeType: "image/png", buffer: PNG_BYTES });

/**
 * Attach through the ONE file input the intake owns.
 *
 * `.first()` IS THE SAME LOCATOR `ticket-references.browser.spec.ts:131` USES,
 * and keeping a single input is what keeps that spec pointed at the control it
 * was written for. A second input added above it would silently retarget an
 * existing test.
 */
async function attach(page: Page, uploads: readonly Upload[]): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles([...uploads]);
}

async function startRun(page: Page): Promise<void> {
  await page.getByRole("button", { name: /start run/i }).click();
}

/* ------------------------------------------------------------------ */
/* The wire                                                            */
/* ------------------------------------------------------------------ */

test("a PDF actually reaches the wire — a chip with a filename is not evidence", async ({
  page,
}) => {
  const harness = await serve(page);
  await typeTicket(page, "Build what the attached scope describes.");
  await attach(page, [pdf("scope.pdf")]);

  // Wait for the chip, so the submit below is a test of the POST and not a race
  // against `FileReader`. The tag and the filename are (c)'s requirement: a
  // document chip must be distinguishable from an image chip and must say WHICH
  // file, because "a file is attached" is not the reassurance being asked for.
  //
  // `getByTitle` RATHER THAN `getByText` for the name: the chip truncates at
  // 160px and the full name lives in `title`, so this asserts the fact that
  // survives a long filename. The tag is matched EXACTLY, so it cannot be
  // satisfied by the enclosing chip's concatenated text.
  await expect(page.getByTitle("scope.pdf")).toBeVisible();
  await expect(
    page.getByText("PDF", { exact: true }),
    "an image chip and a document chip must not be the same chip",
  ).toBeVisible();

  await startRun(page);
  await expect.poll(() => harness.creates.length).toBe(1);

  const body = harness.creates[0] as { documents?: readonly string[] };
  expect(
    body.documents,
    "the chip rendered but the document never reached the POST — the run would be graded " +
      "against a different ticket id than the owner believes they submitted",
  ).toBeDefined();
  expect(body.documents).toHaveLength(1);
  expect(
    body.documents?.[0] ?? "",
    "the payload must be a base64 data URL of the PDF's own media type; the server's " +
      "`decodeDocumentDataUrl` refuses anything else with `not-a-data-url`",
  ).toMatch(/^data:application\/pdf;base64,/);
});

test("NO attachment leaves `documents` absent, not an empty array", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "A ticket with no attachment at all.");

  await startRun(page);
  await expect.poll(() => harness.creates.length).toBe(1);

  const body = harness.creates[0] as object;
  // Not `toEqual([])` — the KEY must be missing. `exactOptionalPropertyTypes` on
  // the server wants absence, and model-picker asserts whole bodies with toEqual.
  expect(
    Object.hasOwn(body, "documents"),
    "an unconditional `documents: []` compiles, renders identically, and turns five " +
      "unrelated model-picker specs red",
  ).toBe(false);
  expect(
    Object.hasOwn(body, "references"),
    "the documents change must not have made `references` unconditional either",
  ).toBe(false);
});

test("a refused type is NAMED, and nothing about it reaches the wire", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "A ticket whose attachment the server would refuse.");
  await attach(page, [
    { name: "archive.zip", mimeType: "application/zip", buffer: Buffer.from("PK") },
  ]);

  // SCOPED TO THE ALERT THAT SAYS SOMETHING. Next.js mounts a permanently-empty
  // `#__next-route-announcer__` with `role="alert"` on every page, so a bare
  // `getByRole("alert")` is a strict-mode violation that fails whether or not the
  // refusal rendered — a locator that cannot pass is not a check. Filtering on
  // "has any non-whitespace text" excludes the announcer without baking the
  // expected wording into the locator, which would make the assertions below
  // tautological.
  const refusal = page.getByRole("alert").filter({ hasText: /\S/ });
  await expect(refusal).toBeVisible();
  await expect(
    refusal,
    "the refusal must name the type it was given — 'that file cannot be attached' leaves " +
      "the owner guessing which of a dropped folder was refused, and why",
  ).toContainText("application/zip");
  await expect(refusal).toContainText("archive.zip");

  // THE HALF THAT CANNOT BE SEEN ON SCREEN: a control that shows the error and
  // attaches the file anyway passes every assertion above.
  await startRun(page);
  await expect.poll(() => harness.creates.length).toBe(1);
  const body = harness.creates[0] as object;
  expect(Object.hasOwn(body, "documents"), "a refused file must not be posted").toBe(false);
  expect(Object.hasOwn(body, "references"), "nor smuggled into the image array").toBe(false);
});

test("an image and a document go into DIFFERENT arrays", async ({ page }) => {
  const harness = await serve(page);
  await typeTicket(page, "Match the reference and follow the scope.");
  await attach(page, [png("hero.png"), pdf("scope.pdf")]);

  await expect(page.getByTitle("hero.png")).toBeVisible();
  await expect(page.getByTitle("scope.pdf")).toBeVisible();

  await startRun(page);
  await expect.poll(() => harness.creates.length).toBe(1);

  const body = harness.creates[0] as {
    references?: readonly string[];
    documents?: readonly string[];
  };
  expect(body.references).toHaveLength(1);
  expect(body.documents).toHaveLength(1);
  expect(body.references?.[0] ?? "").toMatch(/^data:image\/png;base64,/);
  expect(
    body.documents?.[0] ?? "",
    "a PDF sent in `references` fails `decodeReferenceDataUrl` and refuses the whole " +
      "submission — the split is the only thing stopping that",
  ).toMatch(/^data:application\/pdf;base64,/);
});

/* ------------------------------------------------------------------ */
/* The planner — no page                                               */
/* ------------------------------------------------------------------ */

const candidate = (name: string, type: string, size = 1024): AttachmentCandidate => ({
  name,
  type,
  size,
});

const attached = (name: string, kind: Attachment["kind"]): Attachment => ({
  name,
  kind,
  mediaType: kind === "image" ? "image/png" : "application/pdf",
  dataUrl: "data:,",
});

test("the two caps are counted separately — six images AND four documents fit", () => {
  const files = [
    ...Array.from({ length: MAX_REFERENCE_IMAGES }, (_unused, i) =>
      candidate(`shot-${String(i)}.png`, "image/png"),
    ),
    ...Array.from({ length: MAX_REFERENCE_DOCUMENTS }, (_unused, i) =>
      candidate(`scope-${String(i)}.pdf`, "application/pdf"),
    ),
  ];
  const plan = planAttachmentIntake(files, []);
  expect(
    plan.take,
    "one combined cap would silently drop four files the API would have accepted — the " +
      "server holds MAX_REFERENCE_IMAGES and MAX_REFERENCE_DOCUMENTS independently",
  ).toHaveLength(MAX_REFERENCE_IMAGES + MAX_REFERENCE_DOCUMENTS);
  expect(plan.refusal).toBeNull();
});

test("overflow past the document cap is COUNTED and named, never sliced away", () => {
  const files = Array.from({ length: MAX_REFERENCE_DOCUMENTS + 2 }, (_unused, i) =>
    candidate(`scope-${String(i)}.pdf`, "application/pdf"),
  );
  const plan = planAttachmentIntake(files, []);
  expect(plan.take).toHaveLength(MAX_REFERENCE_DOCUMENTS);
  expect(plan.refusal ?? "").toContain("2 of these were not attached");
});

test("room is measured against what is ALREADY attached, per kind", () => {
  const existing = [attached("a.pdf", "document"), attached("b.pdf", "document")];
  const plan = planAttachmentIntake(
    [candidate("c.pdf", "application/pdf"), candidate("d.pdf", "application/pdf"), candidate("e.pdf", "application/pdf")],
    existing,
  );
  expect(plan.take).toHaveLength(MAX_REFERENCE_DOCUMENTS - existing.length);
  expect(plan.refusal ?? "").toContain("1 of these was not attached");
});

test("an oversized document is refused with BOTH numbers, and the rest still attach", () => {
  const plan = planAttachmentIntake(
    [
      candidate("huge.pdf", "application/pdf", MAX_DOCUMENT_BYTES + 1),
      candidate("small.pdf", "application/pdf"),
    ],
    [],
  );
  expect(plan.take).toHaveLength(1);
  expect(plan.refusal ?? "").toContain("huge.pdf");
  expect(plan.refusal ?? "").toContain("12 MB");
});

test("the image size cap is the IMAGE's, not the document's", () => {
  // 12 MB is legal for a document and is not legal for an image. A single shared
  // cap would let this through the client and 400 at the server.
  const plan = planAttachmentIntake(
    [candidate("huge.png", "image/png", MAX_REFERENCE_IMAGE_BYTES + 1)],
    [],
  );
  expect(plan.take).toHaveLength(0);
  expect(plan.refusal ?? "").toContain("8 MB");
});

test("an SVG is refused — the chat's old `image/` prefix filter let it through to a 400", () => {
  const plan = planAttachmentIntake([candidate("logo.svg", "image/svg+xml")], []);
  expect(plan.take).toHaveLength(0);
  expect(
    plan.refusal ?? "",
    "`decodeReferenceDataUrl` accepts png/jpeg/jpg/webp/gif only; a pre-flight that " +
      "matches `image/*` refuses nothing the server refuses",
  ).toContain("image/svg+xml");
});

test("a file the browser gives no type for is refused, and says that is why", () => {
  const plan = planAttachmentIntake([candidate("NOTES", "")], []);
  expect(plan.take).toHaveLength(0);
  expect(plan.refusal ?? "").toContain("no type reported by the browser");
});

test("an empty file is refused here rather than at the server", () => {
  const plan = planAttachmentIntake([candidate("blank.pdf", "application/pdf", 0)], []);
  expect(plan.take).toHaveLength(0);
  expect(plan.refusal ?? "").toContain("empty");
});

test("a policy that refuses documents keeps images and returns its OWN sentence", () => {
  // This is the chat composer's configuration: `documentsRefused` non-null. It
  // exercises the PLANNER's behaviour under that policy — not a claim that
  // `OrchestratorChat` passes the policy in, which nothing in this suite mounts.
  const plan = planAttachmentIntake(
    [candidate("scope.pdf", "application/pdf"), candidate("hero.png", "image/png")],
    [],
    { documentsRefused: "documents are not wired here." },
  );
  expect(plan.take).toHaveLength(1);
  expect(plan.take[0]?.name).toBe("hero.png");
  expect(plan.refusal ?? "").toContain("documents are not wired here.");
  expect(plan.refusal ?? "").toContain("scope.pdf");
});

test("every reason is reported, not just the last one", () => {
  const plan = planAttachmentIntake(
    [
      candidate("logo.svg", "image/svg+xml"),
      candidate("huge.pdf", "application/pdf", MAX_DOCUMENT_BYTES + 1),
    ],
    [],
  );
  const refusal = plan.refusal ?? "";
  expect(refusal).toContain("logo.svg");
  expect(
    refusal,
    "the previous single-slot error state overwrote the wrong-type message with the " +
      "over-the-limit one, and the owner saw only whichever landed second",
  ).toContain("huge.pdf");
});

/* ------------------------------------------------------------------ */
/* Parity with the server's own declarations                           */
/* ------------------------------------------------------------------ */

/** Reads a server module as TEXT. It cannot be imported: `node:fs` at module scope. */
function serverSource(file: string): string {
  const testsDir = dirname(test.info().file);
  return readFileSync(resolve(testsDir, "..", "server", "src", file), "utf8");
}

/**
 * A numeric constant's value, with the arithmetic restricted to what these
 * declarations actually use.
 *
 * NOT `eval`, AND NOT A SILENT DEFAULT. Anything that is not a product of
 * integers fails the test naming what it found — if the server switches to
 * `Number(process.env…)` this must go red, not quietly return 0 and then agree
 * with a client constant it never compared to.
 */
function serverConstant(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(source);
  expect(match, `\`export const ${name}\` was not found — the declaration moved`).not.toBeNull();
  const expression = (match?.[1] ?? "").trim();
  expect(
    /^\d+(\s*\*\s*\d+)*$/.test(expression),
    `${name} is \`${expression}\`, which this test cannot evaluate; compare it by hand`,
  ).toBe(true);
  return expression.split("*").reduce((total, part) => total * Number(part.trim()), 1);
}

test("the client's accepted document types are exactly the server's ACCEPTED map", () => {
  const source = serverSource("document-intake.ts");
  const block = /const ACCEPTED: Readonly<Record<string, string>> = \{([\s\S]*?)\n\};/.exec(source);
  expect(
    block,
    "the `ACCEPTED` declaration was not found in server/src/document-intake.ts — it was " +
      "renamed or reshaped, and this test was comparing against nothing until it said so",
  ).not.toBeNull();

  const server = new Map<string, string>();
  for (const [, type = "", extension = ""] of (block?.[1] ?? "").matchAll(
    /"([^"]+)":\s*"([^"]+)"/g,
  )) {
    server.set(type, extension);
  }
  expect(server.size, "no entries parsed out of the ACCEPTED block").toBeGreaterThan(0);

  expect(
    Object.fromEntries(ACCEPTED_DOCUMENT_TYPES),
    "src/lib/attachments.ts transcribes this map and nothing but this test keeps the copy " +
      "honest: a type only the server knows is one this form refuses to attach, and a type " +
      "only the client knows is a 400 after the upload",
  ).toEqual(Object.fromEntries(server));
});

test("the client's accepted image types are exactly the server's regex alternation", () => {
  const source = serverSource("ticket-refs.ts");
  const match = /\^data:image\\\/\(([a-z|]+)\);base64/.exec(source);
  expect(
    match,
    "`decodeReferenceDataUrl`'s data-URL regex was not found in server/src/ticket-refs.ts",
  ).not.toBeNull();
  const server = (match?.[1] ?? "").split("|").map((subtype) => `image/${subtype}`);
  expect(server.length).toBeGreaterThan(0);
  expect([...ACCEPTED_IMAGE_TYPES].sort()).toEqual([...server].sort());
});

test("the client's four caps are the server's four caps", () => {
  const documents = serverSource("document-intake.ts");
  const images = serverSource("ticket-refs.ts");

  expect(MAX_REFERENCE_DOCUMENTS).toBe(serverConstant(documents, "MAX_REFERENCE_DOCUMENTS"));
  expect(MAX_DOCUMENT_BYTES).toBe(serverConstant(documents, "MAX_DOCUMENT_BYTES"));
  expect(MAX_REFERENCE_IMAGES).toBe(serverConstant(images, "MAX_REFERENCE_IMAGES"));
  expect(MAX_REFERENCE_IMAGE_BYTES).toBe(serverConstant(images, "MAX_REFERENCE_IMAGE_BYTES"));
});
