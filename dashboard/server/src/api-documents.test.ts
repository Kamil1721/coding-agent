/**
 * api-documents.test.ts — the two DOCUMENT intakes, over a real loopback server.
 *
 * A SEPARATE FILE FROM `api-references.test.ts` FOR THE REASON THAT FILE GIVES
 * FOR ITS OWN EXISTENCE: it owns one concern (reference images and the site
 * capture) and was being edited in the same session as this change. This one
 * owns the concern the owner added — "say for example i hand it a brief of the
 * project, a scope or a cv" — across BOTH surfaces they asked for: the ticket
 * form (`POST /api/runs`) and the orchestrator chat
 * (`POST /api/runs/:id/messages`).
 *
 * WHAT IS STUBBED, AND WHAT THAT COSTS. The orchestrator is a no-op object and
 * the site capture is injected, exactly as in `api-references.test.ts`: starting
 * a real run spawns a builder and spends the owner's quota, and a browser must
 * never launch here. Nothing below is therefore evidence that a document is
 * READ by anything — no seat runs in this file. Every assertion is about the
 * ROUTE: what it refuses, what it writes, what it records, what it puts on the
 * run's event stream, and which ticket the run ends up addressing.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS TO PIN, each with the failure it
 * watches for:
 *
 *   1. PATHS AND DIGESTS, NEVER BYTES. A base64 payload that survives into the
 *      SQLite row or into the manifest is a 12 MB blob re-read on every list
 *      poll — and, per `document-intake.ts`, an unredactable one. Asserted by
 *      searching the serialised row AND the manifest for the payload itself,
 *      not by trusting the shape.
 *   2. DOCUMENTS ARE IDENTITY. The owner decided a changed reference is a
 *      different ticket with its own frozen suite; a scope document is a
 *      reference. The negative control is the pair: the id MOVES when a document
 *      is attached, and `sha256` does NOT — `spec-agent.ts:632` and
 *      `runner.ts:1124` refuse a ticket whose `sha256` is not exactly its
 *      brief's digest, so a fold into the wrong field fails the run at the first
 *      seat rather than here.
 *   3. THE ENVELOPE ADMITS A DOCUMENT-SIZED BODY. This file already carried a
 *      measured defect where a documented per-attachment limit was unreachable
 *      because the route used the 1 MB default envelope, and the refusal named a
 *      cap no request could reach. The negative control for it is a route that
 *      did NOT opt in refusing the same body — without that half, "the upload
 *      worked" says nothing about which cap applied.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import type { CreateRunResponse, SseEvent } from "./api-types.js";
import { AuthProbe } from "./auth.js";
import { RunEventBus } from "./bus.js";
import type { ChatMessage } from "./db.js";
import { RunStore } from "./db.js";
import { MAX_DOCUMENT_BODY_BYTES, MAX_REFERENCE_DOCUMENTS } from "./document-intake.js";
import { GateProbe } from "./health-gate.js";
import {
  LOOPBACK_HOST,
  MAX_ATTACHMENT_BODY_BYTES,
  MAX_IMAGE_BODY_BYTES,
  createDashboardServer,
} from "./http.js";
import type { HttpDeps, RunController } from "./http.js";
import { ModelCatalog } from "./models.js";
import type { DashboardPaths } from "./paths.js";
import { ensureDirs, resolvePaths } from "./paths.js";
import type { SiteCaptureResult } from "./site-capture.js";
import { documentDirFor, readReferenceManifest, referenceDirFor } from "./ticket-refs.js";
import { ticketFromStoredBrief, ticketFromStoredReferences, ticketFromText } from "./ticket.js";

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
  readonly store: RunStore;
  readonly paths: DashboardPaths;
  close(): Promise<void>;
}

/**
 * The trimmed harness, copied in shape from `api-references.test.ts`.
 *
 * THE CLAUDE STUB IS NOT OPTIONAL: `ModelCatalog` emits no rows without a real
 * login probe, so every submission here would 409 on `model_unavailable` before
 * reaching a line of the code this file is about. A throwaway executable is used
 * rather than a mock so the actual `execFile` probe runs.
 *
 * THE CAPTURE ALWAYS REFUSES. `captureSite` is wired to a failure, so no test in
 * this file can accidentally depend on a capture — the site path has its own
 * file, and a capture would additionally move the ticket ids these tests compare.
 */
async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dash-docs-"));
  const paths = resolvePaths({ DASHBOARD_HOME: dir });
  ensureDirs(paths);

  const store = RunStore.open(paths.database);
  const bus = new RunEventBus(store);
  const claudeBin = join(dir, "claude-stub");
  writeFileSync(claudeBin, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n', "utf8");
  chmodSync(claudeBin, 0o755);
  const auth = new AuthProbe({ claudeBin, codexBin: join(dir, "nope"), env: process.env });
  const catalog = new ModelCatalog(auth, {}, async () => FAKE_MODELS);
  const orchestrator: RunController = {
    pump: () => undefined,
    cancel: () => false,
    resume: () => false,
    // FALSE, so the chat route takes the boundary-drain branch. Nothing here
    // exercises live delivery; `live-input.test.ts` owns that.
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
    captureSite: (): Promise<SiteCaptureResult> =>
      Promise.resolve({ ok: false, reason: "captures are switched off in this file" }),
  };
  const server = createDashboardServer(deps);
  await new Promise<void>((resolve) => server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    store,
    paths,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function submit(harness: Harness, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${harness.base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId: "opus[1m]", ...body }),
  });
}

/** A run id from a submission that must have succeeded. */
async function runIdOf(response: Response): Promise<string> {
  const body = (await response.json()) as CreateRunResponse & { message?: string };
  assert.equal(response.status, 201, body.message ?? "expected the submission to be accepted");
  return body.runId;
}

/**
 * `data:application/pdf;base64,…` over `bytes` copies of one filler byte.
 *
 * THE BYTES ARE NOT A REAL PDF, and no test here needs them to be: this file
 * exercises the ROUTE, which — like `decodeReferenceDataUrl` before it —
 * deliberately does not verify the media type against the content
 * (`document-intake.ts` says why, and names the consequence: a fake PDF reaches
 * `pdftotext` and fails there, by name). What matters is that the filler differs
 * per `seed`, so two documents digest differently.
 */
function pdfDataUrl(seed: string, bytes = 64): string {
  return `data:application/pdf;base64,${Buffer.alloc(bytes, seed.charCodeAt(0)).toString("base64")}`;
}

function payloadOf(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

function logLines(harness: Harness, runId: string): readonly { level: string; text: string }[] {
  return harness.store
    .eventsSince(runId, 0)
    .map((stored) => stored.event as SseEvent)
    .filter((event): event is Extract<SseEvent, { type: "log" }> => event.type === "log")
    .map((event) => ({ level: event.level, text: event.text }));
}

/* -------------------------------------------------------------------------
 * 1. POST /api/runs — the ticket form
 * ---------------------------------------------------------------------- */

test("a ticket document is written to disk, recorded as a PATH AND A DIGEST, and moves the ticket id", async () => {
  const harness = await startHarness();
  try {
    /*
     * "the attached scope" UNTIL 2026-08-12, AND THE WORDING IS LOAD-BEARING IN A
     * WAY IT WAS NOT WHEN IT WAS WRITTEN. This test submits the SAME text twice —
     * once with no attachments, to prove the ticket id moves when a document is
     * added — and `briefShape` now refuses a brief that claims an attachment on a
     * request carrying nothing at all. The first submission was therefore a
     * dangling promise by the intake check's own definition, and a correct 400.
     *
     * Reworded rather than exempted. Nothing this test measures — the id moving,
     * `sha256` staying the digest of the brief, the bytes landing under the run's
     * own directory — depends on the brief claiming an attachment, and the rule
     * that now refuses it has both its arms tested in `brief-shape.test.ts`.
     */
    const text = "Build the thing described in the scope";
    const scope = pdfDataUrl("s", 512);

    const plain = await runIdOf(await submit(harness, { ticketText: text }));
    const withDoc = await runIdOf(await submit(harness, { ticketText: text, documents: [scope] }));

    const plainRow = harness.store.getRun(plain);
    const docRow = harness.store.getRun(withDoc);
    assert.ok(plainRow !== null && docRow !== null);

    assert.equal(plainRow.ticketId, ticketFromText(text).id, "no attachments: the id is unchanged, forever");
    assert.notEqual(docRow.ticketId, plainRow.ticketId, "the owner's decision: a document is part of identity");
    assert.equal(docRow.ticketText, text, "a document adds no text to the brief the spec seat reads");
    assert.equal(docRow.ticketSha256, plainRow.ticketSha256, "sha256 stays the digest of the brief, unwidened");

    // THE BYTES ARE WHERE THE ROUTE SAYS THEY ARE, under the run's own directory
    // and named by ordinal so the manifest order and the disk order agree.
    const documentPath = join(documentDirFor(harness.paths.runs, withDoc), "document-1.pdf");
    assert.equal(readFileSync(documentPath).byteLength, 512);

    const manifest = readReferenceManifest(referenceDirFor(harness.paths.runs, withDoc));
    assert.equal(manifest?.documents?.length, 1);
    assert.equal(manifest?.documents?.[0]?.path, documentPath);
    assert.equal(manifest?.documents?.[0]?.bytes, 512);
    assert.equal(manifest?.documents?.[0]?.mediaType, "application/pdf");
    assert.match(manifest?.documents?.[0]?.sha256 ?? "", /^[0-9a-f]{64}$/, "a real sha256, not a placeholder");
    assert.deepEqual(manifest?.images, [], "a documents-only ticket records no images");

    /*
     * NEITHER THE ROW NOR THE MANIFEST MAY CARRY THE PAYLOAD.
     *
     * The row is read on every list poll and the manifest on every build; a
     * base64 document in either is the cost the path indirection exists to
     * avoid. It is also, per `document-intake.ts`, the one attachment kind
     * `redactForPersistence` cannot see into — a PDF containing a live key would
     * be persisted whole. Searching for the payload catches it however it got
     * there; a shape assertion would not.
     */
    const rowJson = JSON.stringify(docRow);
    assert.ok(!rowJson.includes("data:application/pdf"), "no data URL survived into the row");
    assert.ok(!rowJson.includes(payloadOf(scope)), "and neither did the bytes");
    const manifestJson = readFileSync(join(referenceDirFor(harness.paths.runs, withDoc), "references.json"), "utf8");
    assert.ok(!manifestJson.includes(payloadOf(scope)), "nor into the manifest");
  } finally {
    await harness.close();
  }
});

test("the READ-BACK path agrees with the intake, and the images-only one does not", async () => {
  const harness = await startHarness();
  try {
    const text = "Follow the attached scope";
    const runId = await runIdOf(await submit(harness, { ticketText: text, documents: [pdfDataUrl("s")] }));
    const row = harness.store.getRun(runId);
    const manifest = readReferenceManifest(referenceDirFor(harness.paths.runs, runId));
    assert.ok(row !== null && manifest !== null);

    // THE PROPERTY THE WHOLE PIPELINE RESTS ON. The orchestrator does not trust
    // `row.ticketId`; it re-derives the ticket from the stored brief plus the
    // manifest, and a derivation that disagrees sends the run to
    // `authorAndFreezeSuite` — real quota, and a suite the row's own id does not
    // name.
    assert.equal(
      ticketFromStoredReferences(row.ticketText, manifest).id,
      row.ticketId,
      "the manifest read-back must land on the id the intake persisted",
    );

    /*
     * THE NEGATIVE CONTROL, AND IT IS ALSO THE OUTSTANDING HANDOFF.
     *
     * `ticketFromStoredBrief(brief, manifest.images)` is the expression
     * `orchestrator.ts` still evaluates. If it produced the same id, this file's
     * "documents are identity" claim would be vacuous — the digests would not be
     * entering the id at all. It differs, which proves they do, AND states
     * plainly that the orchestrator has not yet been switched to
     * `ticketFromStoredReferences(row0.ticketText, manifest)`: until it is, a
     * documents-bearing run derives a different ticket than the intake wrote
     * (the orchestrator emits a `warn` naming both ids, so it is visible, but it
     * costs a re-authored suite).
     *
     * WHEN THAT SWITCH LANDS, this assertion is still correct as written: it is
     * about the two FUNCTIONS, not about the caller. Do not delete it — invert
     * it only if `ticketFromStoredBrief` itself learns to fold documents.
     */
    assert.notEqual(
      ticketFromStoredBrief(row.ticketText, manifest.images).id,
      row.ticketId,
      "the images-only derivation cannot see a document, which is exactly why it must not be used",
    );
  } finally {
    await harness.close();
  }
});

test("identity is the document's CONTENT: same bytes reuse the ticket, different bytes do not", async () => {
  const harness = await startHarness();
  try {
    const text = "Implement the attached brief";
    const first = await runIdOf(await submit(harness, { ticketText: text, documents: [pdfDataUrl("a")] }));
    const again = await runIdOf(await submit(harness, { ticketText: text, documents: [pdfDataUrl("a")] }));
    const other = await runIdOf(await submit(harness, { ticketText: text, documents: [pdfDataUrl("b")] }));

    const ticketOf = (runId: string): string | undefined => harness.store.getRun(runId)?.ticketId;

    // The two submissions wrote their copies into DIFFERENT run directories, so
    // the paths differ and only the digests can be deciding this. A second
    // submission of an unchanged scope must reuse the frozen suite rather than
    // pay to author an identical one.
    assert.notEqual(
      join(documentDirFor(harness.paths.runs, first), "document-1.pdf"),
      join(documentDirFor(harness.paths.runs, again), "document-1.pdf"),
    );
    assert.equal(ticketOf(first), ticketOf(again), "same words, same bytes: the same ticket");
    assert.notEqual(ticketOf(first), ticketOf(other), "an amended scope is a different ticket, by the owner's rule");
  } finally {
    await harness.close();
  }
});

test("the owner is TOLD the document was stored and not read, on the run's own stream", async () => {
  const harness = await startHarness();
  try {
    const runId = await runIdOf(
      await submit(harness, { ticketText: "Use the attached scope", documents: [pdfDataUrl("s", 128)] }),
    );
    const warning = logLines(harness, runId).find((line) => line.level === "warn" && /document/.test(line.text));

    /*
     * THIS IS THE HONEST HALF OF THE FEATURE AND IT IS ASSERTED, NOT ASSUMED.
     * The intake stores a document and folds it into the ticket id; it hands it
     * to no agent. An `info` line saying "1 document attached" would let an
     * owner read a run that never opened their scope as one that did — the same
     * failure the reference notes exist to prevent, which is why the reason is
     * in the text and the level is `warn`.
     */
    assert.ok(warning !== undefined, "a silently stored attachment is one the owner thinks was used");
    assert.match(warning.text, /STORED, NOT READ/);
    assert.match(warning.text, /identity/, "and is told what it DID change");
    assert.match(warning.text, /document-1\.pdf/, "with the path, so it can be handed over by hand");
  } finally {
    await harness.close();
  }
});

test("a bad document is refused by NAME, and nothing is written", async () => {
  const harness = await startHarness();
  try {
    const tooMany = await submit(harness, {
      ticketText: "x",
      documents: Array.from({ length: MAX_REFERENCE_DOCUMENTS + 1 }, (_, index) => pdfDataUrl(String(index))),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(((await tooMany.json()) as { error: string }).error, "too_many_documents");

    // AN IMAGE IS NOT A DOCUMENT. The refusal must name the type it was given
    // and list the ones it takes, because "invalid" alone sends the owner back
    // to the file picker with no idea what to pick.
    const wrongType = await submit(harness, {
      ticketText: "x",
      documents: ["data:image/png;base64,aGVsbG8="],
    });
    assert.equal(wrongType.status, 400);
    const refusal = (await wrongType.json()) as { error: string; message: string; remediation: string | null };
    assert.equal(refusal.error, "invalid_document");
    assert.match(refusal.message, /image\/png is not an accepted document type/);
    assert.match(refusal.remediation ?? "", /application\/pdf/, "the accepted list is offered, not just refused");

    const notADataUrl = await submit(harness, { ticketText: "x", documents: ["/Users/me/scope.pdf"] });
    assert.equal(notADataUrl.status, 400);
    assert.equal(((await notADataUrl.json()) as { error: string }).error, "invalid_document");

    const notAnArray = await submit(harness, { ticketText: "x", documents: "scope.pdf" });
    assert.equal(notAnArray.status, 400);
    assert.equal(((await notAnArray.json()) as { error: string }).error, "invalid_body");

    assert.equal(harness.store.listRuns().length, 0, "a refused submission creates no run");
    // AND NO BYTES. Validation happens before the run id is minted, so a request
    // refused on its second document cannot leave a half-written intake behind.
    assert.equal(readdirSync(harness.paths.runs).length, 0, "and no run directory");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * 2. The request envelope — the cap that must admit a real document
 * ---------------------------------------------------------------------- */

test("THE ENVELOPE IS THE SUM OF THE TWO ATTACHMENT BUDGETS, not the larger of them", async () => {
  /*
   * ARITHMETIC, NOT A REQUEST, AND DELIBERATELY SO. Proving the sum with a real
   * body would mean posting well over 64 MB, which is not a test anybody runs
   * twice. What can fail here is the arithmetic itself: a "simplification" to
   * `Math.max(...)` would refuse a legitimate request carrying six images AND
   * four documents while every per-attachment limit the API advertises says it
   * is fine — the exact shape of the defect this file already found once, where
   * a documented per-image cap was unreachable under the default envelope.
   * `document-intake.ts` states the rule where `MAX_DOCUMENT_BODY_BYTES` is
   * declared; this is the check that the route obeyed it.
   */
  assert.equal(MAX_ATTACHMENT_BODY_BYTES, MAX_IMAGE_BODY_BYTES + MAX_DOCUMENT_BODY_BYTES);
  assert.ok(MAX_ATTACHMENT_BODY_BYTES > MAX_IMAGE_BODY_BYTES, "images alone are not the budget");
  assert.ok(MAX_ATTACHMENT_BODY_BYTES > MAX_DOCUMENT_BODY_BYTES, "documents alone are not the budget either");
});

test("a document-sized body is admitted here, and refused on a route that did not opt in", async () => {
  const harness = await startHarness();
  try {
    // 2 MB decoded is ~2.7 MB of base64 — comfortably over the 1 MB default
    // envelope, and the size at which the old single global cap killed uploads
    // while quoting a per-file limit no request could reach.
    const big = pdfDataUrl("z", 2 * 1024 * 1024);
    const runId = await runIdOf(await submit(harness, { ticketText: "The attached scope", documents: [big] }));
    assert.equal(
      readFileSync(join(documentDirFor(harness.paths.runs, runId), "document-1.pdf")).byteLength,
      2 * 1024 * 1024,
      "the whole document arrived, not a truncated prefix",
    );

    /*
     * THE NEGATIVE CONTROL, WITHOUT WHICH THE LINE ABOVE PROVES NOTHING.
     *
     * "A 2 MB upload succeeded" is consistent with `readBody` having no cap at
     * all. `POST /api/runs/:id/resume` carries no attachments and therefore
     * keeps the small default; the SAME body must die there, naming the limit
     * that actually fired. That is what makes the cap per-route rather than
     * global, and it is the property the create route depends on.
     *
     * IT SURFACES AS A 500, NOT A 400, because that route does not catch
     * `readBody`'s throw — `createDashboardServer`'s handler does. Pinned as it
     * is rather than as it ought to be: an untidy status is a smaller problem
     * than a test that asserts a behaviour this server does not have.
     */
    const refused = await fetch(`${harness.base}/api/runs/${runId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chosenMockup: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(refused.status, 500);
    const body = (await refused.json()) as { message: string };
    assert.match(body.message, /request body too large/);
    assert.match(body.message, /1048576/, "the refusal names the cap that applied, not the one it did not");
  } finally {
    await harness.close();
  }
});

/* -------------------------------------------------------------------------
 * 3. POST /api/runs/:id/messages — the orchestrator chat
 * ---------------------------------------------------------------------- */

async function sendMessage(harness: Harness, runId: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${harness.base}/api/runs/${runId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a chat document is stored under the run's chat directory and is NOT filed as an image", async () => {
  const harness = await startHarness();
  try {
    const runId = await runIdOf(await submit(harness, { ticketText: "Build a landing page" }));
    const response = await sendMessage(harness, runId, {
      text: "here is the scope we agreed",
      documents: [pdfDataUrl("c", 256)],
    });
    assert.equal(response.status, 202);

    const body = (await response.json()) as { message: ChatMessage; live: boolean; documents: readonly string[] };
    assert.equal(body.documents.length, 1);
    assert.ok(body.documents[0]?.includes(join("runs", runId, "chat")), "chat attachments live beside the chat");
    assert.equal(readFileSync(body.documents[0] ?? "").byteLength, 256);

    /*
     * THE NAME-LIE CONTROL. The one shortcut available here was to put the
     * document's path into `message.images`, which would have delivered it
     * through machinery that already exists — and would have made the messages
     * table, `LiveMessage` and `ownerMessageBlock` all say "image" about a PDF,
     * and instruct an agent to read it as one. This assertion is what stops a
     * future edit from taking that shortcut quietly.
     */
    assert.deepEqual(body.message.images, [], "a document is not an image, in the row or anywhere else");
    const stored = harness.store.messages(runId);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0]?.images, []);
    // THE WRITTEN PATH ITSELF, not a `.pdf` substring: this message's text
    // contains no filename, so a substring check would pass for the wrong
    // reason today and fail spuriously the first time a test message mentions
    // one. Searching the whole serialised row for the exact path is what
    // catches the document being smuggled into ANY column.
    assert.ok(
      !JSON.stringify(stored).includes(body.documents[0] ?? " never"),
      "no document path reached the message row, in any field",
    );
  } finally {
    await harness.close();
  }
});

test("the run is told, on its own stream, that a chat document was stored and not delivered", async () => {
  const harness = await startHarness();
  try {
    const runId = await runIdOf(await submit(harness, { ticketText: "Build a landing page" }));
    await sendMessage(harness, runId, { text: "the scope", documents: [pdfDataUrl("c")] });

    const warning = logLines(harness, runId).find((line) => line.level === "warn" && /document/.test(line.text));
    /*
     * WITHOUT THIS LINE THE ROUTE IS A SILENT NO-OP DRESSED AS ACCEPTANCE: a
     * 202, a file on disk, and a run that never hears about it. The chat channel
     * carries text and image paths only, and this is where that limitation is
     * said out loud to the person it affects. Wiring delivery without removing
     * the warning, or removing the warning without wiring delivery, fails here.
     */
    assert.ok(warning !== undefined, "a stored-but-undelivered attachment must not be silent");
    assert.match(warning.text, /STORED, NOT DELIVERED/);
    assert.match(warning.text, /no documents column|no field for one/, "and why, in terms of the actual channel");
    assert.match(warning.text, /-doc-1\.pdf/, "with the path, so the owner can name it in a follow-up");
  } finally {
    await harness.close();
  }
});

test("a chat message may be a document alone, and its refusals are named", async () => {
  const harness = await startHarness();
  try {
    const runId = await runIdOf(await submit(harness, { ticketText: "Build a landing page" }));

    // A DOCUMENT ALONE IS A MESSAGE. Refusing it as `empty_message` would refuse
    // the plainest use of the feature — "here, read this" with nothing typed.
    const documentOnly = await sendMessage(harness, runId, { documents: [pdfDataUrl("d")] });
    assert.equal(documentOnly.status, 202);

    const nothing = await sendMessage(harness, runId, {});
    assert.equal(nothing.status, 400);
    assert.equal(((await nothing.json()) as { error: string }).error, "empty_message");

    const tooMany = await sendMessage(harness, runId, {
      text: "lots",
      documents: Array.from({ length: MAX_REFERENCE_DOCUMENTS + 1 }, (_, index) => pdfDataUrl(String(index))),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(((await tooMany.json()) as { error: string }).error, "too_many_documents");

    const wrongType = await sendMessage(harness, runId, { documents: ["data:video/mp4;base64,aGVsbG8="] });
    assert.equal(wrongType.status, 400);
    const refusal = (await wrongType.json()) as { error: string; message: string };
    assert.equal(refusal.error, "invalid_document");
    assert.match(refusal.message, /video\/mp4/, "the same module's sentence, not a second vaguer one");

    // ONE MESSAGE STORED, not four: every refusal above happened before a byte
    // was written, so the refused attachments left nothing behind.
    assert.equal(harness.store.messages(runId).length, 1);
    assert.equal(readdirSync(join(harness.paths.runs, runId, "chat")).length, 1);
  } finally {
    await harness.close();
  }
});

test("a chat document does NOT move the run's ticket id", async () => {
  const harness = await startHarness();
  try {
    const text = "Build a landing page";
    const runId = await runIdOf(await submit(harness, { ticketText: text }));
    const before = harness.store.getRun(runId)?.ticketId;
    await sendMessage(harness, runId, { text: "the scope", documents: [pdfDataUrl("c")] });

    /*
     * THE ASYMMETRY THAT IS EASY TO GET WRONG. A TICKET's documents are identity;
     * a MESSAGE's are not, because this run's frozen suite is already addressed
     * by the id in its row. If a mid-run attachment moved it, a running run would
     * start looking for a suite that does not exist — and the manifest, not the
     * chat, is where identity is recorded, which is why the chat writes to
     * `chat/` and never to `documents/`.
     */
    assert.equal(harness.store.getRun(runId)?.ticketId, before, "a mid-run attachment is not ticket identity");
    assert.equal(harness.store.getRun(runId)?.ticketId, ticketFromText(text).id);
    assert.ok(
      !existsSync(documentDirFor(harness.paths.runs, runId)),
      "and it is not written where the ticket's documents live",
    );
  } finally {
    await harness.close();
  }
});
