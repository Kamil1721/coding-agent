/**
 * document-intake.test.ts — the watchers for the four ways this module can lie:
 * an argv that has quietly lost `-layout`, an unreadable document that returns
 * as an empty success, a truncation that does not announce itself, and a
 * credential cut in half by that truncation.
 *
 * WHY ARGV IS ASSERTED RATHER THAN OUTPUT. A unit test cannot depend on a real
 * PDF existing on the machine, so the extraction itself is driven through an
 * injected runner. That leaves the argv as the only place the flag which decides
 * whether a table's rows survive can be pinned — and it is the flag whose loss
 * produces no error, no warning and a plausible-looking wrong answer.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// TEST-ONLY, and deliberately not imported by `src`: see the drift watcher at
// the bottom of this file for why the block's shape is declared structurally in
// document-intake.ts and only checked against the SDK here.
import type { DocumentBlockParam } from "@anthropic-ai/sdk/resources";

import {
  ACCEPTED_DOCUMENT_MEDIA_TYPES,
  DEFAULT_DOCUMENT_PROMPT_CHARS,
  DOCUMENT_BLOCK_BEGIN,
  MAX_DOCUMENT_BODY_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_NATIVE_PDF_BYTES,
  decodeDocumentDataUrl,
  documentPromptText,
  extractDocumentText,
  nativeDocumentBlock,
  pdftotextArgv,
  routeFor,
  textutilArgv,
} from "./document-intake.js";
import type { DecodedDocument, ExtractedDocument, NativeDocumentBlock } from "./document-intake.js";
import { DOCUMENTS_NOT_PROBED } from "./document-capability.js";
import type { CaptureResult, CaptureRunner, DocumentCapability } from "./document-capability.js";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const READY: DocumentCapability = {
  pdftotext: { id: "pdftotext", state: "ok", detail: "pdftotext version 26.04.0", checkedAt: "t" },
  textutil: { id: "textutil", state: "ok", detail: "textutil usage", checkedAt: "t" },
};

const NO_POPPLER: DocumentCapability = {
  pdftotext: {
    id: "pdftotext",
    state: "unavailable",
    detail: "pdftotext could not be spawned: spawn pdftotext ENOENT. brew install poppler.",
    checkedAt: "t",
  },
  textutil: READY.textutil,
};

function capture(patch: Partial<CaptureResult> = {}): CaptureResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, capped: false, spawnError: null, ...patch };
}

/** A runner that answers with fixed output and records the argv it was given. */
function runnerFor(answer: CaptureResult): { run: CaptureRunner; argv: string[][] } {
  const argv: string[][] = [];
  const run: CaptureRunner = async (command, args) => {
    argv.push([command, ...args]);
    return answer;
  };
  return { run, argv };
}

function dataUrl(mediaType: string, body: string): string {
  return `data:${mediaType};base64,${Buffer.from(body, "utf8").toString("base64")}`;
}

/**
 * A credential-SHAPED string that no real service issued.
 *
 * It has to be long enough for the rule to fire (`sk-ant-[A-Za-z0-9_-]{16,}`),
 * because the whole point of the ordering test below is that a SHORTER survivor
 * would not match.
 */
const FAKE_KEY = `sk-ant-${"A".repeat(40)}`;

/* -------------------------------------------------------------------------
 * decodeDocumentDataUrl — every refusal is named
 * ---------------------------------------------------------------------- */

test("a PDF data URL decodes to bytes, a media type and an extension", () => {
  const decoded = decodeDocumentDataUrl(`data:application/pdf;base64,${Buffer.from("%PDF-1.4").toString("base64")}`);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.mediaType, "application/pdf");
  assert.equal(decoded.extension, "pdf");
  assert.equal(decoded.bytes.toString("utf8"), "%PDF-1.4");
});

test("the .docx media type — 71 characters no naive pattern survives — is accepted", () => {
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const decoded = decodeDocumentDataUrl(dataUrl(docx, "PK"));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.extension, "docx");
  assert.ok(ACCEPTED_DOCUMENT_MEDIA_TYPES.includes(docx));
});

test("both spellings of RTF are accepted, because browsers emit both", () => {
  for (const type of ["application/rtf", "text/rtf"]) {
    const decoded = decodeDocumentDataUrl(dataUrl(type, "{\\rtf1}"));
    assert.equal(decoded.ok, true, `${type} must decode`);
    if (decoded.ok) assert.equal(decoded.extension, "rtf");
  }
});

test("a ;charset= parameter does not break the parse — browsers add one for text", () => {
  const decoded = decodeDocumentDataUrl(
    `data:text/plain;charset=utf-8;base64,${Buffer.from("hello").toString("base64")}`,
  );
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.equal(decoded.mediaType, "text/plain");
});

test("A WRONG MIME IS REFUSED BY NAME, and the refusal lists what is accepted", () => {
  const decoded = decodeDocumentDataUrl(dataUrl("image/png", "not really a png"));
  assert.equal(decoded.ok, false);
  if (decoded.ok) return;
  assert.equal(decoded.code, "unsupported-media-type");
  assert.match(decoded.detail, /image\/png is not an accepted document type/);
  assert.match(decoded.detail, /application\/pdf/);
});

test("AN OVERSIZED DOCUMENT IS REFUSED BY NAME, and the refusal states the real cap", () => {
  // The measured defect at http.ts:147 was a refusal naming a limit no request
  // could reach. This asserts the number in the sentence is the number enforced.
  const oversized = `data:application/pdf;base64,${Buffer.alloc(MAX_DOCUMENT_BYTES + 1024).toString("base64")}`;
  const decoded = decodeDocumentDataUrl(oversized);
  assert.equal(decoded.ok, false);
  if (decoded.ok) return;
  assert.equal(decoded.code, "too-large");
  assert.match(decoded.detail, new RegExp(`the limit is ${String(MAX_DOCUMENT_BYTES)} bytes`));
});

test("a document exactly AT the cap is accepted — the boundary is not off by one", () => {
  const atCap = `data:application/pdf;base64,${Buffer.alloc(MAX_DOCUMENT_BYTES, 1).toString("base64")}`;
  assert.equal(decodeDocumentDataUrl(atCap).ok, true);
});

test("the other three refusals are distinguishable from each other", () => {
  const notString = decodeDocumentDataUrl({ nope: true });
  assert.equal(notString.ok, false);
  if (!notString.ok) assert.equal(notString.code, "not-a-string");

  const notDataUrl = decodeDocumentDataUrl("https://example.com/brief.pdf");
  assert.equal(notDataUrl.ok, false);
  if (!notDataUrl.ok) assert.equal(notDataUrl.code, "not-a-data-url");

  // "====" is in the alphabet and decodes to zero bytes: the shape passes and
  // the payload is nothing, which is a different fault from a bad shape.
  const empty = decodeDocumentDataUrl("data:application/pdf;base64,====");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "empty");
});

test("the derived body budget is what a route must pass to readBody", () => {
  // Four documents of 12 MB is exactly 64 MB of base64 plus slack. If someone
  // raises MAX_DOCUMENT_BYTES without re-deriving this, the route silently goes
  // back to refusing anything over ~750 KB as a body error (http.ts:147).
  assert.equal(MAX_DOCUMENT_BODY_BYTES, 4 * Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 256 * 1024);
  assert.ok(MAX_DOCUMENT_BODY_BYTES > MAX_DOCUMENT_BYTES, "the envelope must exceed one document");
});

/* -------------------------------------------------------------------------
 * The argv — the flag whose loss corrupts data silently
 * ---------------------------------------------------------------------- */

test("THE PDF ARGV CARRIES -layout AND THE STDOUT OPERAND", () => {
  const argv = pdftotextArgv("/runs/r1/documents/scope.pdf");

  // MEASURED: without -layout a three-column table is serialised column-first,
  // severing each row's cells from each other; with it the rows survive intact.
  assert.ok(argv.includes("-layout"), "-layout is what keeps a table's rows together");

  // MEASURED: `pdftotext -layout in.pdf` exits 0, prints NOTHING, and writes
  // in.txt beside the input — it overwrote a file during this investigation. So
  // the trailing `-` is not cosmetic: without it there is no text AND a stray
  // write into the run's directory.
  assert.equal(argv[argv.length - 1], "-", "the output operand must be stdout");
  assert.deepEqual(argv, ["-layout", "-enc", "UTF-8", "/runs/r1/documents/scope.pdf", "-"]);
});

test("the office argv writes to stdout rather than beside the input", () => {
  assert.deepEqual(textutilArgv("/runs/r1/documents/cv.docx"), [
    "-convert",
    "txt",
    "-stdout",
    "/runs/r1/documents/cv.docx",
  ]);
});

test("routing sends each type at the tool that can read it, and text at neither", () => {
  assert.equal(routeFor("application/pdf"), "pdftotext");
  assert.equal(routeFor("application/msword"), "textutil");
  assert.equal(routeFor("text/markdown"), "inline");
  assert.equal(routeFor("application/json"), "inline");
  assert.equal(routeFor("image/png"), null);
});

test("the argv the extractor is actually given is the argv above", async () => {
  // Pinning `pdftotextArgv` alone would pass even if extractDocumentText built
  // its own list, which is exactly how a flag gets lost.
  const { run, argv } = runnerFor(capture({ stdout: "Discovery   Ana   12000\n" }));
  await extractDocumentText("/tmp/scope.pdf", "application/pdf", READY, { run });
  assert.deepEqual(argv, [["pdftotext", "-layout", "-enc", "UTF-8", "/tmp/scope.pdf", "-"]]);
});

/* -------------------------------------------------------------------------
 * Degradation — a document that could not be read never reads as empty text
 * ---------------------------------------------------------------------- */

test("AN UNAVAILABLE EXTRACTOR DEGRADES WITH A REASON AND SPAWNS NOTHING", async () => {
  const { run, argv } = runnerFor(capture());
  const extracted = await extractDocumentText("/tmp/brief.pdf", "application/pdf", NO_POPPLER, { run });

  assert.notEqual(extracted.degraded, null, "an unreadable document must carry a reason");
  assert.equal(extracted.degraded?.code, "extractor-unavailable");
  assert.match(String(extracted.degraded?.detail), /ENOENT/, "the probe's own sentence, not a new one");
  assert.equal(extracted.via, "none");
  assert.deepEqual(argv, [], "nothing may be spawned once the probe says the tool is missing");

  // THE POINT OF THE TEST: the prompt text is not empty and names the failure.
  // An empty string here would produce a prompt that has forgotten the owner
  // attached anything.
  const prompt = documentPromptText(extracted);
  assert.notEqual(prompt.trim(), "");
  assert.match(prompt, /IT COULD NOT BE READ/);
  assert.match(prompt, /extractor-unavailable/);
  assert.match(prompt, /Do not guess what it said/);
});

test("AN UNPROBED EXTRACTOR IS ITS OWN DEGRADATION, not folded into 'unavailable'", async () => {
  const { run, argv } = runnerFor(capture());
  const extracted = await extractDocumentText("/tmp/brief.pdf", "application/pdf", DOCUMENTS_NOT_PROBED, {
    run,
  });
  assert.equal(extracted.degraded?.code, "extractor-not-probed");
  assert.deepEqual(argv, [], "a capability nobody measured must not be treated as a working tool");
});

test("EXIT 0 WITH NO TEXT IS A NAMED FAILURE, not a successful empty document", async () => {
  // MEASURED: a PDF exported as page images returns exit 0 and a stdout of
  // exactly one byte, 0x0c. If the form feed were counted as content, a scanned
  // CV would enter the prompt as an empty but "successful" document.
  const { run } = runnerFor(capture({ stdout: "\f" }));
  const extracted = await extractDocumentText("/tmp/scan.pdf", "application/pdf", READY, { run });

  assert.equal(extracted.text, "");
  assert.equal(extracted.degraded?.code, "no-text-extracted");
  assert.match(String(extracted.degraded?.detail), /no text layer/);
  assert.match(documentPromptText(extracted), /IT COULD NOT BE READ/);
});

test("textutil's exit 0 on an unreadable file is caught by the same check", async () => {
  // MEASURED: `textutil -convert txt -stdout /nope/missing.docx` EXITS 0 and
  // says "Error reading … The file doesn't exist." on stderr. Its exit code
  // cannot be trusted, so the emptiness check is what catches it.
  const { run } = runnerFor(capture({ stdout: "", stderr: "Error reading /nope/missing.docx." }));
  const extracted = await extractDocumentText("/nope/missing.docx", "application/msword", READY, { run });

  assert.equal(extracted.degraded?.code, "no-text-extracted");
  assert.match(String(extracted.degraded?.detail), /exit code does not distinguish/);
  assert.match(String(extracted.degraded?.detail), /Error reading/);
});

test("a non-zero exit and a spawn failure both degrade, quoting the tool", async () => {
  const failed = await extractDocumentText("/tmp/not.pdf", "application/pdf", READY, {
    run: runnerFor(capture({ code: 1, stderr: "Syntax Error: Couldn't find trailer dictionary" })).run,
  });
  assert.equal(failed.degraded?.code, "extractor-failed");
  assert.match(String(failed.degraded?.detail), /trailer dictionary/);

  const missing = await extractDocumentText("/tmp/x.pdf", "application/pdf", READY, {
    run: runnerFor(capture({ code: 127, spawnError: "pdftotext could not be spawned: ENOENT" })).run,
  });
  assert.equal(missing.degraded?.code, "extractor-failed");
});

test("A CAPPED EXTRACTION KEEPS ITS TEXT — the kill's exit code is not the tool's verdict", async () => {
  /*
   * THE DEFECT THIS WATCHES, WHICH SHIPPED GREEN ONCE. Hitting the byte bound
   * SIGKILLs the child, so `close` fires with a null code and `CaptureResult`
   * reports 1 (measured, three runs out of three) — identical to pdftotext
   * rejecting the file. Checked in that order, a 400-page PDF's first 4 MB is
   * thrown away and reported as `extractor-failed`, and the "CUT SHORT" branch
   * of documentPromptText becomes unreachable for both subprocess routes.
   *
   * Move the `capped` check back below the exit-code check and this goes red.
   */
  const { run } = runnerFor(capture({ code: 1, capped: true, stdout: "the first four megabytes" }));
  const extracted = await extractDocumentText("/tmp/huge.pdf", "application/pdf", READY, { run });

  assert.equal(extracted.degraded, null, "a cut we made ourselves is not a tool failure");
  assert.equal(extracted.text, "the first four megabytes", "the text we already have is not discarded");
  assert.equal(extracted.outputCapped, true);
  assert.equal(extracted.via, "pdftotext");
  assert.match(documentPromptText(extracted), /THE EXTRACTOR ITSELF WAS CUT SHORT/);
});

test("a capped extraction that produced nothing visible still degrades", async () => {
  // The negative control for the branch above: `capped` must not become a
  // blanket amnesty that turns an empty result into a success.
  const { run } = runnerFor(capture({ code: 1, capped: true, stdout: "\f" }));
  const extracted = await extractDocumentText("/tmp/scan.pdf", "application/pdf", READY, { run });
  assert.equal(extracted.text, "");
  assert.notEqual(extracted.degraded, null);
});

test("a timed-out extractor discards what it had, and says it did", async () => {
  const { run } = runnerFor(capture({ timedOut: true, stdout: "the first two pages of forty" }));
  const extracted = await extractDocumentText("/tmp/huge.pdf", "application/pdf", READY, {
    run,
    timeoutMs: 20_000,
  });
  assert.equal(extracted.text, "", "half a document read as a whole one is worse than none");
  assert.equal(extracted.degraded?.code, "extractor-timed-out");
  assert.match(String(extracted.degraded?.detail), /20000 ms/);
});

test("empty text and a null reason can never occur together, in either direction", async () => {
  const cases: readonly ExtractedDocument[] = [
    await extractDocumentText("/tmp/a.pdf", "application/pdf", NO_POPPLER, { run: runnerFor(capture()).run }),
    await extractDocumentText("/tmp/b.pdf", "application/pdf", READY, {
      run: runnerFor(capture({ stdout: "\f\f" })).run,
    }),
    await extractDocumentText("/tmp/c.pdf", "application/pdf", READY, {
      run: runnerFor(capture({ stdout: "real text" })).run,
    }),
    await extractDocumentText("/tmp/d.png", "image/png", READY, { run: runnerFor(capture()).run }),
  ];
  for (const extracted of cases) {
    assert.equal(
      extracted.text === "",
      extracted.degraded !== null,
      `${extracted.path}: empty text must imply a named reason and vice versa`,
    );
  }
});

test("an unroutable media type degrades instead of reaching a subprocess", async () => {
  const { run, argv } = runnerFor(capture());
  const extracted = await extractDocumentText("/tmp/x.png", "image/png", READY, { run });
  assert.equal(extracted.degraded?.code, "unsupported-media-type");
  assert.deepEqual(argv, []);
});

/* -------------------------------------------------------------------------
 * The inline route, against a real filesystem
 * ---------------------------------------------------------------------- */

test("EXECUTED: a text file is read directly, with no subprocess at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-inline-"));
  const path = join(dir, "scope.md");
  writeFileSync(path, "# Scope\n\n- ship the thing\n", "utf8");

  const { run, argv } = runnerFor(capture());
  const extracted = await extractDocumentText(path, "text/markdown", DOCUMENTS_NOT_PROBED, { run });

  assert.equal(extracted.via, "inline");
  assert.match(extracted.text, /ship the thing/);
  assert.equal(extracted.degraded, null);
  assert.deepEqual(argv, [], "text needs no extractor, so an unprobed capability must not block it");
});

test("EXECUTED: a file that is not there degrades as unreadable, it does not throw", async () => {
  const extracted = await extractDocumentText("/nope/missing.txt", "text/plain", READY);
  assert.equal(extracted.degraded?.code, "unreadable-file");
  assert.equal(extracted.text, "");
});

test("EXECUTED: an oversized text file is bounded, and the bound is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-bound-"));
  const path = join(dir, "huge.txt");
  writeFileSync(path, "y".repeat(50_000), "utf8");

  const extracted = await extractDocumentText(path, "text/plain", READY, { maxBytes: 1_000 });
  assert.equal(extracted.text.length, 1_000);
  assert.equal(extracted.outputCapped, true);
  assert.match(documentPromptText(extracted), /THE EXTRACTOR ITSELF WAS CUT SHORT/);
});

/* -------------------------------------------------------------------------
 * Redaction, and the ORDER it happens in
 * ---------------------------------------------------------------------- */

test("a credential in an extracted document is redacted before it can be persisted", async () => {
  const { run } = runnerFor(capture({ stdout: `Deploy key: ${FAKE_KEY}\nrest of the brief` }));
  const extracted = await extractDocumentText("/tmp/brief.pdf", "application/pdf", READY, { run });
  assert.doesNotMatch(extracted.text, /sk-ant-A/);
  assert.match(extracted.text, /\[REDACTED:/);
  assert.match(extracted.text, /rest of the brief/, "only the credential goes, not the document");
});

test("REDACTION HAPPENS BEFORE TRUNCATION — a cut key would leave a usable prefix", async () => {
  /*
   * THE FAILURE THIS WATCHES. redact.ts's rules need minimum spans
   * (`sk-ant-[A-Za-z0-9_-]{16,}`). Truncate first and the survivor at the cut is
   * a 15-character fragment no rule matches, so a credential PREFIX reaches the
   * prompt — which redact.ts's own header calls a leak ("nothing here emits a
   * prefix, a suffix, a last-4 or a length").
   *
   * The key is positioned to straddle the cut deliberately: reverse the order in
   * document-intake.ts and this assertion goes red.
   *
   * THE PADDING ENDS IN A NEWLINE, AND THAT IS NOT COSMETIC. The rule is
   * `(?<![A-Za-z0-9_-])sk-ant-…`, so a key glued onto the end of a word is not a
   * token and is deliberately left alone — an earlier draft of this fixture
   * concatenated the two and failed, which is the rule behaving correctly rather
   * than a leak. A key in a real document is preceded by whitespace or a colon.
   */
  const cap = 200;
  const padding = `${"x".repeat(cap - 11)}\n`;
  const { run } = runnerFor(capture({ stdout: `${padding}${FAKE_KEY} and more text after` }));
  const extracted = await extractDocumentText("/tmp/brief.pdf", "application/pdf", READY, { run });
  const prompt = documentPromptText(extracted, cap);

  assert.doesNotMatch(prompt, /sk-ant-/, "not even the first characters of the key may survive the cut");
  assert.match(prompt, /\[REDACTED:/, "the key was inside the shown region, so its placeholder must be");
  assert.match(prompt, /showing \d+ of \d+ characters/);
});

test("the label is redacted too, and the host path never reaches the prompt", async () => {
  // `ticket-refs.ts`'s rule for the brief: no absolute path in seat-facing text.
  const { run } = runnerFor(capture({ stdout: "the scope" }));
  const extracted = await extractDocumentText(
    "/Users/someone/runs/r1/documents/Project Scope.pdf",
    "application/pdf",
    READY,
    { run },
  );
  const prompt = documentPromptText(extracted);
  assert.equal(extracted.label, "Project Scope.pdf");
  assert.match(prompt, /"Project Scope\.pdf"/);
  assert.doesNotMatch(prompt, /\/Users\/someone/, "the directory must not appear in seat-facing text");
});

/* -------------------------------------------------------------------------
 * documentPromptText — the cut announces itself
 * ---------------------------------------------------------------------- */

test("TRUNCATION MARKS ITSELF, AT BOTH ENDS, WITH THE REAL NUMBERS", async () => {
  const body = "S".repeat(1_000);
  const { run } = runnerFor(capture({ stdout: body }));
  const extracted = await extractDocumentText("/tmp/scope.pdf", "application/pdf", READY, { run });
  const prompt = documentPromptText(extracted, 100);

  assert.match(prompt, /TRUNCATED: showing 100 of 1000 characters/);
  assert.match(prompt, /END OF EXCERPT \(TRUNCATED: 100 of 1000 characters shown\)/);
  assert.equal(
    (prompt.match(/S/gu) ?? []).length,
    100,
    "the marked count must be the count actually shown",
  );
  assert.match(prompt, /do not conclude that a requirement is missing/);
});

test("a document that fits says so, and carries no truncation marker", async () => {
  const { run } = runnerFor(capture({ stdout: "a short brief" }));
  const extracted = await extractDocumentText("/tmp/brief.pdf", "application/pdf", READY, { run });
  const prompt = documentPromptText(extracted, DEFAULT_DOCUMENT_PROMPT_CHARS);

  assert.match(prompt, /Showing all 13 characters/);
  assert.doesNotMatch(prompt, /TRUNCATED/);
  assert.ok(prompt.includes(DOCUMENT_BLOCK_BEGIN));
  assert.match(prompt, /a short brief/);
});

test("the prompt states that pdftotext output is a RECONSTRUCTION, not the PDF", async () => {
  // A model told "this is the document" will trust a mis-joined table row. A
  // model told the columns were reconstructed from position has a reason to
  // hedge, which is the honest description of what -layout produces.
  const { run } = runnerFor(capture({ stdout: "Phase   Owner   Budget" }));
  const extracted = await extractDocumentText("/tmp/t.pdf", "application/pdf", READY, { run });
  assert.match(documentPromptText(extracted), /reconstructed/);
});

/* -------------------------------------------------------------------------
 * The native path — primary for PDFs
 * ---------------------------------------------------------------------- */

function decodedPdf(bytes: number): DecodedDocument {
  return { ok: true, mediaType: "application/pdf", extension: "pdf", bytes: Buffer.alloc(bytes, 7) };
}

test("a PDF inside budget becomes a base64 document block that round-trips", () => {
  const document = decodedPdf(1024);
  const decision = nativeDocumentBlock(document, { title: "scope.pdf" });
  assert.equal(decision.kind, "native");
  if (decision.kind !== "native") return;

  assert.equal(decision.block.type, "document");
  assert.equal(decision.block.source.type, "base64");
  assert.equal(decision.block.source.media_type, "application/pdf");
  assert.equal(decision.block.title, "scope.pdf");
  assert.deepEqual(
    Buffer.from(decision.block.source.data, "base64"),
    document.bytes,
    "the model must receive the same bytes the owner uploaded",
  );
  assert.doesNotMatch(decision.block.source.data, /^data:/u, "the API takes the payload, not a data URL");
});

test("A PDF OVER THE NATIVE BUDGET IS DECLINED BY NAME — and not dropped", () => {
  const decision = nativeDocumentBlock(decodedPdf(MAX_NATIVE_PDF_BYTES + 1));
  assert.equal(decision.kind, "declined");
  if (decision.kind !== "declined") return;
  assert.equal(decision.code, "over-native-budget");
  assert.match(decision.detail, /Fall back to extractDocumentText/);
});

test("a non-PDF has no native form, and the refusal says why rather than failing quietly", () => {
  const docx: DecodedDocument = {
    ok: true,
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
    bytes: Buffer.from("PK"),
  };
  const decision = nativeDocumentBlock(docx);
  assert.equal(decision.kind, "declined");
  if (decision.kind !== "declined") return;
  assert.equal(decision.code, "not-a-pdf");
  assert.match(decision.detail, /base64 document source is application\/pdf only/);
});

test("the caller's own budget wins over the default", () => {
  assert.equal(nativeDocumentBlock(decodedPdf(2048), { budgetBytes: 1024 }).kind, "declined");
  assert.equal(nativeDocumentBlock(decodedPdf(2048), { budgetBytes: 4096 }).kind, "native");
});

/**
 * THE SDK-DRIFT WATCHER.
 *
 * `NativeDocumentBlock` is declared structurally in `document-intake.ts` because
 * `@anthropic-ai/sdk/resources` is a TRANSITIVE dependency that this package's
 * own package.json does not declare — importing it from `src` would put a
 * runtime-adjacent dependency on something no lockfile entry of ours pins. The
 * cost of that decision is that the shape could drift from the API's own type
 * and nothing would say so.
 *
 * This is what says so. `npm run build` compiles the tests, so if
 * `DocumentBlockParam` stops accepting this shape — a renamed field, a narrowed
 * media_type union — the build fails here rather than at runtime with a 400 from
 * the API. It is a type-level assertion: there is nothing to execute.
 */
test("the native block is still assignable to the SDK's DocumentBlockParam", () => {
  const decision = nativeDocumentBlock(decodedPdf(16), { title: "t.pdf" });
  assert.equal(decision.kind, "native");
  if (decision.kind !== "native") return;

  const block: NativeDocumentBlock = decision.block;
  // The assignment IS the assertion; tsc rejects the file if the shapes diverge.
  const asSdkBlock: DocumentBlockParam = block;
  assert.equal(asSdkBlock.type, "document");
});
