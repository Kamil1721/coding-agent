/**
 * subscription-caller.ts — how the EXISTING spec agent runs with no API key.
 *
 * THE PROBLEM. `generateAuditedSuite` (bakeoff/src/spec-agent.ts) is the whole
 * gate machinery: author, deterministic 28-check bad-test audit, adversarial
 * judge pass, regenerate-on-blocking-finding, then build the `AcceptanceSuite`
 * that `freezeSuite` seals and the scorer later verifies by digest. It reaches
 * the model through `AnthropicSeatCaller`, which requires `ANTHROPIC_API_KEY`.
 * The dashboard has no API key and must never require one.
 *
 * THE CHOICE. Re-implementing the loop was rejected: `buildAcceptanceSuite` is
 * internal to spec-agent.ts, so a re-implementation would have to hand-assemble
 * the `AcceptanceSuite` whose `acceptanceSuiteDigest` is then checked three
 * ways downstream (`assertRunMatchesSuite`, `verifySuiteIntact`, the freeze
 * itself). A single field out of place there does not surface as a bug — it
 * surfaces as `suite_hash_mismatch`, which the scorer reports as TAMPERING.
 *
 * So this subclasses `AnthropicSeatCaller` and overrides exactly one method:
 * `call()`. Everything above it — prompts, parsing, audit, regeneration,
 * freeze — is the bake-off's own code, unmodified.
 *
 * WHAT THE PLACEHOLDER CREDENTIAL IS AND IS NOT. The base constructor calls
 * `checkCredential(seat.envKeyName, env)` and throws if the variable is absent.
 * It is handed an env in which that ONE variable holds a fixed, non-secret
 * sentinel, following the precedent of `dryRunEnv()` in bakeoff/src/dryrun.ts.
 * It is not a key, it is not key-shaped, and it authenticates nothing: the
 * `Anthropic` HTTP client the base class builds from it is never used, because
 * the only method that touches it is the one overridden here. `assertUnused()`
 * exists so that a future edit which reintroduces a base-class call path fails
 * loudly instead of firing an unauthenticated request at the API.
 *
 * WHAT THE CEILING STILL DOES, AND WHAT IT NO LONGER DOES. `SpendCeiling` is
 * denominated in dollars. A subscription call has no dollar cost, so the
 * worst-case passed to `checkBeforeCall` is 0 and the COST ceiling can never
 * fire. That is stated here rather than left to be discovered, because
 * bakeoff's own STATUS holds that a documented ceiling which cannot fire is
 * worse than no ceiling. Two boundaries do remain live and are the real ones:
 * `checkBeforeCall` still enforces `maxWallClockMs`, and the binding constraint
 * on a subscription is the provider's rate limit — a 5-hour rolling window plus
 * a weekly cap — which is surfaced, persisted and resumable rather than
 * treated as an error.
 *
 * ATTACHED DOCUMENTS, ADDED 2026-07-30, AND WHAT IS AND IS NOT PROVEN ABOUT
 * THEM. This seat used to be reachable only by a single joined STRING, which has
 * nowhere to put a content block. It can now also be handed
 * {@link SeatDocument}s, in which case the prompt takes the SDK's streaming form
 * and the first (and only) user message carries the PDF document blocks followed
 * by the text. The measurement behind that, taken this session and NOT by this
 * file's own tests: a `DocumentBlockParam` with a `Base64PDFSource` was pushed
 * through `query({ prompt: <AsyncIterable<SDKUserMessage>>, options })` against
 * the real CLI subprocess with THIS seat's options (`tools: []`,
 * `settingSources: []`), came back result subtype `success`, and answered a
 * question that required reading table row associations correctly. `tools: []`
 * does not block it because a document is CONTENT, not a tool call.
 *
 * TWO THINGS THAT MEASUREMENT DOES NOT ESTABLISH, BOTH OF WHICH THIS PATH RELIES
 * ON IN PRODUCTION:
 *   - HOW LARGE a document may be. See {@link DEFAULT_SEAT_NATIVE_BASE64_CHARS},
 *     which is a chosen budget rather than a discovered ceiling.
 *   - THAT IT WORKS ALONGSIDE `outputFormat`. The probe asked a free-form
 *     question; every real authoring call this seat makes also carries
 *     `outputFormat: {type: "json_schema"}` (spec-agent's `AUTHORING_JSON_SCHEMA`),
 *     and streaming input + document block + structured output has never been run
 *     together. If that combination is rejected it fails LOUDLY rather than
 *     silently — `error_max_structured_output_retries`, or a subprocess error
 *     through `#asCallError` — and the remediation text on `SEAT_MAX_TURNS_ENV`
 *     already points at schema-validation retries. It is the first thing to watch
 *     on the first live ticket carrying a PDF.
 *
 * WHAT IS WIRED, AND WHAT HAS ACTUALLY BEEN RUN. The production chain exists as
 * of this commit: the ticket route writes attachments to `runs/<id>/documents/`
 * and records them in the reference manifest (`http.ts`), `#seatDocuments` in
 * `orchestrator.ts` reads that manifest, probes the extractors and calls
 * {@link seatDocumentsFor}, and the result reaches this class. What has NOT been
 * run is that chain end to end against a real ticket with a real PDF: every
 * assertion in `subscription-caller.documents.test.ts` stops at the SDK
 * boundary, where `query` is replaced by a recording stub. Treat "a document
 * reaches the spec seat" as wired and type-checked, not as observed.
 */

import { readFileSync, statSync } from "node:fs";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AnthropicSeatCaller, SeatCallError, SpendCeiling } from "bakeoff/dist/anthropic-seat.js";
import type { SeatCallRequest, SeatCallResult, SpendEvent } from "bakeoff/dist/anthropic-seat.js";
import { BakeoffError } from "bakeoff/dist/contracts.js";
import type {
  AnthropicSeat,
  BudgetPolicy,
  PriceField,
  PriceStatus,
  PricingBasis,
  VendorUsage,
} from "bakeoff/dist/contracts.js";
import { PRICE_FIELDS } from "bakeoff/dist/contracts.js";
import { redactText } from "bakeoff/dist/redact.js";
import {
  NOT_RATE_LIMITED,
  assistantText,
  extractTokens,
  rateLimitFrom,
  resultErrorText,
} from "./claude-common.js";
import type { RateLimitState } from "./claude-common.js";
import type { DocumentCapability } from "./document-capability.js";
import {
  DEFAULT_DOCUMENT_PROMPT_CHARS,
  MAX_NATIVE_PDF_BYTES,
  documentPromptText,
  extractDocumentText,
  nativeDocumentBlock,
} from "./document-intake.js";
import type { ExtractedDocument, NativeDocumentBlock } from "./document-intake.js";
import { subscriptionSubprocessEnv } from "./subprocess-env.js";
import { addTokens, zeroTokens } from "./tokens.js";
import type { TokenTotals } from "./tokens.js";

/**
 * The sentinel that satisfies `checkCredential` without being a credential.
 *
 * Assembled at runtime rather than written as one literal so that no
 * key-shaped constant exists in this tree even by coincidence, matching the
 * treatment of the bake-off's own test fixtures (STATUS section 6 item 8). It
 * must not match `PLACEHOLDER_RE` in bakeoff/src/env.ts — that regex is
 * anchored and matches whole words like "placeholder" or "changeme", not this.
 */
export const SUBSCRIPTION_SENTINEL = ["DASHBOARD", "SUBSCRIPTION", "OAUTH", "NO", "API", "KEY"].join("-");

/** Dollars. There is no per-token price on a subscription; there is no bill. */
const SUBSCRIPTION_COST_USD = 0;

/**
 * Turn cap for a seat call, and the variable that raises it.
 *
 * THE DEFAULT IS A MEASURED FLOOR, NOT A BOUND. At `maxTurns: 1` an audit call
 * came back `error_max_turns` — "Reached maximum number of turns (1)" — and
 * killed a run in the spec phase. 8 was then observed to be enough for one
 * suite (twelve criteria, five files). That is all that is known: it is the
 * smallest number proved sufficient once, not a limit anything was measured
 * against.
 *
 * WHY MORE THAN ONE TURN IS NEEDED AT ALL IS INFERENCE, NOT OBSERVATION. The
 * seat has NO TOOLS, so it cannot loop on tool use. The likely consumer is the
 * CLI's own structured-output retry, since the SDK declares a distinct
 * `error_max_structured_output_retries` result subtype — but that mechanism was
 * not watched directly, and this comment should not be read as if it had been.
 *
 * It is a BOUNDARY, not a heuristic — the distinction doc 03 section 7.8 draws.
 * Nothing here inspects progress or decides the seat is stuck.
 */
export const SEAT_MAX_TURNS_ENV = "DASHBOARD_SEAT_MAX_TURNS";
export const DEFAULT_SEAT_CALL_MAX_TURNS = 8;

function seatMaxTurns(env: NodeJS.ProcessEnv): number {
  const raw = (env[SEAT_MAX_TURNS_ENV] ?? "").trim();
  if (raw.length === 0) return DEFAULT_SEAT_CALL_MAX_TURNS;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SEAT_CALL_MAX_TURNS;
}

function subscriptionFieldStatus(): Readonly<Record<PriceField, PriceStatus>> {
  const status: Partial<Record<PriceField, PriceStatus>> = {};
  for (const field of PRICE_FIELDS) status[field] = "unverified";
  return status as Record<PriceField, PriceStatus>;
}

/**
 * Pricing provenance for a subscription call.
 *
 * Every field is `unverified`, which contracts.ts defines as "no known value:
 * usage touching one of these cannot be costed". That is exactly the truth
 * here — not a missing lookup, but an absent concept. Anything that later tries
 * to turn this row into dollars will find the provenance says it cannot.
 */
export function subscriptionPricingBasis(modelId: string, pricedAt: string): PricingBasis {
  return {
    provider: "anthropic",
    modelId,
    priceLabel: "subscription (claude setup-token) — quota consumed, not billed per token",
    priceEffectiveFrom: pricedAt.slice(0, 10),
    priceEffectiveUntil: null,
    pricedAt,
    fieldStatus: subscriptionFieldStatus(),
    assumedFields: [],
    assumedCacheWriteMultiplier: null,
    sourcedOn: pricedAt.slice(0, 10),
    source:
      "No source, because there is no per-token price to source. This seat runs against the owner's " +
      "Claude subscription through the Agent SDK's subprocess CLI. The SDK's own total_cost_usd is " +
      "an API-list-price equivalent, not a bill, and is dropped at the SDK boundary.",
  };
}

/** A usage row for a subscription call: real token counts, no dollars. */
export function subscriptionUsage(
  seat: AnthropicSeat,
  tokens: TokenTotals,
  thinkingTokens: number | null,
): VendorUsage {
  return {
    provider: "anthropic",
    inputTokens: tokens.inputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    outputTokens: tokens.outputTokens,
    costUsd: SUBSCRIPTION_COST_USD,
    modelId: seat.modelId,
    role: seat.role,
    effort: seat.effort,
    callCount: tokens.callCount,
    // The Agent SDK reports no 5m/1h cache-write split. Null means "not
    // reported"; 0 would mean "reported as zero" and would be a lie.
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    thinkingTokens,
  };
}

/* -------------------------------------------------------------------------
 * Attached documents
 * ---------------------------------------------------------------------- */

/**
 * One document the owner attached, in the form this seat needs it.
 *
 * BOTH HALVES ARE SUPPLIED READY-MADE, and that split is deliberate:
 * `document-intake.ts` owns decoding, extraction and redaction — all of which
 * touch the filesystem and spawn host binaries — while the CALLER CLASS below
 * owns only the decision of what goes on the wire per call, which is why its
 * constructor is synchronous and needs no capability probe.
 * {@link seatDocumentsFor}, further down this file, is the one place that turns
 * paths into this shape; it is async, takes a probed capability, and is where
 * the filesystem is touched.
 *
 *   `block`  `nativeDocumentBlock(...)`'s block when the intake produced one
 *            (PDF, inside ITS per-document budget), else null.
 *   `text`   `documentPromptText(extracted)`'s output — the fallback, already
 *            redacted, truncated and ANNOUNCED as truncated. Supply it even
 *            when `block` is non-null: it is what gets used if the block does
 *            not fit this seat's per-call budget, and a document with neither
 *            would otherwise be dropped in silence.
 *
 * `label` IS SEAT-FACING and must be a basename, never a host path — the rule
 * `ticket-refs.ts` states for the brief. Nothing here checks that, because
 * nothing here can: a basename and a path are both strings.
 */
export interface SeatDocument {
  readonly label: string;
  readonly mediaType: string;
  readonly block: NativeDocumentBlock | null;
  readonly text: string;
  /**
   * Why there is no `block`, in the words of whoever decided — or null when a
   * block IS present, or when the caller has nothing to add beyond the media
   * type.
   *
   * IT EXISTS BECAUSE THE OBVIOUS DEFAULT IS SOMETIMES A LIE. With `block: null`
   * and no reason, {@link planSeatDocuments} can only say what the media type
   * implies ("no base64 document source exists for this type"), which is TRUE for
   * a .docx and FALSE for a PDF whose bytes could not be read off disk. A log
   * line that names the wrong cause sends the reader to the wrong fix.
   */
  readonly nativeDeclined: string | null;
}

/**
 * A native document block as it goes on the wire: the intake's block, plus
 * citations.
 *
 * CITATIONS ARE ENABLED BECAUSE THEY ARE THE POINT. `DocumentBlockParam` carries
 * `citations?: CitationsConfigParam`, and with a base64 PDF source the citations
 * the model may emit are PAGE-ANCHORED. A criterion that can name the page of
 * the owner's scope it came from is traceable; one that cannot is an assertion
 * about a document nobody can check it against.
 *
 * WHAT ENABLING THEM DOES NOT DO. It does not make the model cite anything —
 * nothing downstream requires, parses or verifies a citation, and no test here
 * asserts one was produced, because that would need a live model. It permits
 * them. A criterion quoting "page 4" is still the model's claim about page 4.
 */
export interface SeatDocumentBlock extends NativeDocumentBlock {
  readonly citations: { readonly enabled: true };
}

/**
 * How much base64 this seat will carry NATIVELY in ONE call, across ALL
 * documents.
 *
 * WHY A SECOND BUDGET WHEN `document-intake.ts` ALREADY HAS ONE. That one is
 * PER DOCUMENT (`MAX_NATIVE_PDF_BYTES`, 4 MB decoded). Four documents each
 * passing it would put ~21 MB of base64 in every call. This bound is the SUM,
 * and it is derived from the sibling's constant rather than chosen again so the
 * two cannot drift into disagreeing: one document's worth of base64 per call.
 *
 * THE COST THIS BOUNDS, WITH THE MULTIPLIER SPELLED OUT. The document rides in
 * the USER TURN, and `generateAuditedSuite` (bakeoff/dist/spec-agent.js) loops
 * up to `maxAttempts` (3) authoring calls on ONE caller instance, plus one
 * truncation retry that does not consume an attempt — so a worst case of FOUR
 * calls, each re-sending every byte below. At this budget that is ~5.59 MB of
 * base64 per call and ~22.4 MB across four. Whether the CLI's own prompt cache
 * absorbs any repeat is NOT measured here; the honest planning assumption is
 * that it does not.
 *
 * THIS IS A CHOSEN BUDGET, NOT A DISCOVERED CEILING. The session's measurement
 * proves a PDF reaches this seat and is read correctly; it says nothing about
 * how large one may be, and nothing here has driven the CLI's stdin to this
 * size. A document past the bound is NOT dropped — it falls back to its
 * extracted text, and {@link planSeatDocuments} records the reason by name.
 *
 * PAGES ARE NOT BOUNDED, ONLY BYTES. A page count would need `pdfinfo`, which
 * `document-capability.ts` does not probe, and counting `/Type /Page` in the raw
 * bytes UNDER-counts silently on any PDF with compressed object streams — the
 * exact class of quiet wrongness this feature is trying to avoid. So a
 * text-light 300-page PDF passes this bound. Adding `pdfinfo` to the probe is
 * the handoff that would fix it.
 */
export const DEFAULT_SEAT_NATIVE_BASE64_CHARS = Math.ceil((MAX_NATIVE_PDF_BYTES * 4) / 3);

/**
 * What one call will actually carry, decided ONCE at construction.
 *
 * DECIDED ONCE, NOT PER CALL, because every call this seat makes must carry the
 * same attachment: `generateSuite` re-calls the same caller for each
 * regeneration attempt, and a plan recomputed per call could quietly differ
 * between attempt 1 and attempt 3 — a suite audited against a document the
 * regeneration never saw.
 */
export interface SeatDocumentPlan {
  /** Native PDF blocks, in the order given, within budget. */
  readonly blocks: readonly SeatDocumentBlock[];
  /** Everything travelling as text, appended after the user turns. `""` if none. */
  readonly text: string;
  /** Exact base64 characters across {@link blocks}. Re-sent on every call. */
  readonly base64Chars: number;
  /** One sentence per document, for the run log. Never empty when documents were given. */
  readonly notes: readonly string[];
}

/** The plan for a seat with no attachments: the pre-document behaviour exactly. */
export const NO_SEAT_DOCUMENTS: SeatDocumentPlan = Object.freeze({
  blocks: [],
  text: "",
  base64Chars: 0,
  notes: [],
});

/**
 * Decide, per document, whether it travels as bytes or as text — and say why.
 *
 * PDF-ONLY FOR THE NATIVE PATH, AND THAT IS THE API'S TYPE RATHER THAN A POLICY:
 * `Base64PDFSource` is declared `media_type: 'application/pdf'`
 * (@anthropic-ai/sdk `resources/messages/messages.d.ts`), so a .docx has no
 * base64 document form to send. It travels as `textutil`'s extracted text, and
 * `document-intake.ts` is where that text (and its truncation notice) is made.
 *
 * ORDER MATTERS AND IS THE CALLER'S. Documents are considered in the order
 * given; the first ones that fit go native, later ones fall back. Nothing here
 * reorders by size — a run whose 3rd attachment silently displaced its 1st would
 * be harder to explain than one that fills up in the order the owner attached.
 *
 * NO DOCUMENT IS EVER SILENTLY DROPPED. A document with no block and no text
 * still renders {@link undeliveredSection}, which tells the seat the attachment
 * exists, that its contents are absent, and not to guess them. Returning nothing
 * for it would hand the model a prompt that has forgotten an attachment the
 * owner made — the failure `documentPromptText` was written to prevent, and the
 * one `subscription-caller.documents.test.ts` watches fail.
 */
export function planSeatDocuments(
  documents: readonly SeatDocument[],
  budgetBase64Chars: number = DEFAULT_SEAT_NATIVE_BASE64_CHARS,
): SeatDocumentPlan {
  if (documents.length === 0) return NO_SEAT_DOCUMENTS;

  const blocks: SeatDocumentBlock[] = [];
  const sections: string[] = [];
  const notes: string[] = [];
  let base64Chars = 0;

  for (const document of documents) {
    const size = document.block === null ? 0 : document.block.source.data.length;
    if (document.block !== null && base64Chars + size <= budgetBase64Chars) {
      blocks.push({ ...document.block, citations: { enabled: true } });
      base64Chars += size;
      notes.push(
        `${document.label} (${document.mediaType}): sent as a native document block, ` +
          `${String(size)} base64 chars, citations enabled`,
      );
      continue;
    }

    const reason =
      document.block === null
        ? (document.nativeDeclined ?? noBlockReason(document.mediaType))
        : `sending it natively would put ${String(base64Chars + size)} base64 chars into EVERY call ` +
          `this seat makes and the per-call budget is ${String(budgetBase64Chars)}, so it falls back to ` +
          "extracted text";
    notes.push(`${document.label} (${document.mediaType}): ${reason}`);
    sections.push(document.text.trim() === "" ? undeliveredSection(document, reason) : document.text);
  }

  return { blocks, text: sections.join("\n"), base64Chars, notes };
}

/**
 * What to say about a missing block when the caller said nothing.
 *
 * ONLY THE MEDIA TYPE IS CLAIMED, because only the media type is known here. For
 * a PDF that is an admission of ignorance rather than an explanation — the bytes
 * could have been unreadable, oversized at intake, or simply never fetched — and
 * saying so is the point: a confident wrong cause is worse than a named gap.
 */
function noBlockReason(mediaType: string): string {
  return mediaType === "application/pdf"
    ? "no native document block was supplied for this PDF and no reason was given with it, so it " +
        "travels as extracted text"
    : `${mediaType} has no native base64 document source — the API's Base64PDFSource is typed ` +
        "application/pdf only — so it travels as extracted text";
}

/**
 * The last resort: an attachment that has neither bytes nor text to show.
 *
 * DELIBERATELY NOT `documentPromptText`'s degraded branch, which this cannot
 * call — that function takes an `ExtractedDocument` and describes a document
 * that could not be READ. This describes a document that was read (or never
 * needed reading) and could not be CARRIED, which is a different fact with a
 * different fix: the first needs poppler or OCR, this one needs a smaller file.
 */
function undeliveredSection(document: SeatDocument, reason: string): string {
  return [
    "",
    "--- ATTACHED DOCUMENT (NOT IN THIS PROMPT) ---",
    "",
    `The owner attached "${document.label}" (${document.mediaType}). ITS CONTENTS ARE NOT BELOW.`,
    "",
    `Reason: ${reason}. No extracted text was supplied for it either, so none of it is in this prompt.`,
    "",
    "Do not guess what it said and do not write anything that depends on it. If the work needs it, say",
    "plainly that a document was attached and could not be read.",
    "",
    "--- END OF ATTACHED DOCUMENT ---",
    "",
  ].join("\n");
}

/**
 * How this seat obtains a session. `query` is the production value.
 *
 * INJECTABLE FOR THE REASON `SessionFactory` IN builders/claude-builder.ts IS:
 * the real `query` spawns the CLI and spends the owner's subscription, so every
 * branch below it — the document plan reaching the wire, the SAME plan reaching
 * the SECOND call, the no-document path staying a plain string — is otherwise
 * reachable only by a test nobody runs twice. The hole a default argument opens
 * (a stub silently replacing the SDK) is pinned the same way that file pins it:
 * `subscription-caller.documents.test.ts` asserts a default-constructed caller's
 * factory IS `query`, by identity.
 *
 * NARROWER THAN `Query` ON PURPOSE. `Query` also carries `interrupt`,
 * `setPermissionMode` and the rest of the control-request surface, none of which
 * this seat uses; `Query` satisfies this type by construction (it extends
 * `AsyncGenerator<SDKMessage, void>`), so production is unchanged.
 */
export type SeatSessionFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * The prompt for one seat call: a plain string, or the streaming form.
 *
 * THE NO-DOCUMENT PATH IS BYTE-IDENTICAL TO THE ORIGINAL, and that is the
 * property everything else in this repository depends on — every existing test,
 * the whole bake-off, and the frozen suites already on disk. With an empty plan
 * this returns exactly `request.userTurns.join("\n\n")`, the same expression the
 * pre-document code passed to `query`, and the test asserts it with
 * `assert.equal` on the value AND `typeof` on the shape. Same discipline as
 * `BuildRequest.liveInput?`: absent means the previous path exactly.
 *
 * TEXT-ONLY DOCUMENTS ALSO STAY ON THE STRING PATH. If nothing goes native there
 * is no content block to carry, so the extracted text is appended to the string
 * and the SDK is called exactly as before. Streaming input is used ONLY when
 * there is at least one document block — the narrowest possible extension of the
 * old path.
 *
 * WHY THE GENERATOR IS ALLOWED TO COMPLETE, WHEN `live-input.ts` PARKS FOREVER.
 * That file's recorded trap is a generator that RETURNS after its first message:
 * the SDK ends the session when the input iterable completes, so a long-lived
 * build session dies after one turn with no error anywhere, and `LiveInput`
 * parks on a promise so "nothing queued" is a WAIT rather than an end. A SEAT
 * CALL IS THE OPPOSITE SHAPE. It is one-shot: one user message, one assistant
 * answer, one `result` frame, and `call()` returns as soon as the stream is
 * drained. Here ENDING is the correct behaviour — parking would leave the
 * subprocess alive with `call()` awaiting a stream that can never finish, i.e.
 * the run would hang rather than stop early. The session-level measurement that
 * a document reaches this seat was taken through exactly this shape (a generator
 * that yields once and returns) and came back `success`.
 */
export function seatPrompt(
  request: SeatCallRequest,
  plan: SeatDocumentPlan,
): string | AsyncIterable<SDKUserMessage> {
  const turns = request.userTurns.join("\n\n");
  const text = plan.text === "" ? turns : `${turns}\n${plan.text}`;
  if (plan.blocks.length === 0) return text;
  return oneShotDocumentMessage(plan.blocks, text);
}

/**
 * One user message: the documents first, then the text.
 *
 * DOCUMENTS BEFORE TEXT because the text refers to them ("the owner attached
 * …") and because a document block trailing the instruction reads as an
 * afterthought to the model in the same way it does to a person. The API imposes
 * no order.
 *
 * A FRESH GENERATOR PER CALL. An async generator is single-use: iterating it
 * twice yields nothing the second time, so a shared instance would send the
 * document on the first authoring attempt and an EMPTY prompt on the
 * regeneration. `call()` therefore builds the prompt inside the call, and the
 * test drives two calls and asserts both carried the block.
 */
async function* oneShotDocumentMessage(
  blocks: readonly SeatDocumentBlock[],
  text: string,
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: [...blocks, { type: "text", text }] },
    parent_tool_use_id: null,
  };
  // AND THEN IT RETURNS, WHICH ENDS THE SESSION. See `seatPrompt` above for why
  // that is right here and wrong in `live-input.ts`.
}

/**
 * What the run log should say about an attachment, in numbers this code
 * measured rather than estimated.
 *
 * `base64Chars` is the exact size of what goes on the wire and `calls` is the
 * exact number of dispatches that carried it — no token figure is quoted,
 * because this file has no way to convert one into the other and a plausible
 * "≈ N tokens per page" would be a fabricated number in a log the owner reads
 * as measurement.
 */
export function describeSeatDocuments(plan: SeatDocumentPlan, calls: number): string {
  if (plan.notes.length === 0) return "no documents were attached to this seat";
  const carried =
    plan.blocks.length === 0
      ? "nothing was sent natively"
      : `${String(plan.blocks.length)} native block(s), ${String(plan.base64Chars)} base64 chars, re-sent on ` +
        `each of ${String(calls)} call(s) = ${String(plan.base64Chars * calls)} base64 chars in total`;
  return `${String(plan.notes.length)} attached document(s): ${plan.notes.join("; ")} — ${carried}`;
}

/* -------------------------------------------------------------------------
 * From a file on disk to a SeatDocument
 * ---------------------------------------------------------------------- */

/**
 * A document as the run's reference manifest records it: a path and a type.
 *
 * DELIBERATELY NOT `ReferenceDocument` FROM ticket-refs.ts, though that is what
 * the orchestrator will pass. This module has no business knowing what a
 * manifest is, and a structural pair keeps the dependency pointing one way: the
 * orchestrator knows about both, the seat knows about neither.
 */
export interface AttachedDocument {
  /**
   * Absolute host path. Used to READ the file and never rendered into
   * seat-facing text: {@link seatDocumentsFor} carries the redacted basename
   * instead, which is `ticket-refs.ts`'s rule for the brief.
   */
  readonly path: string;
  readonly mediaType: string;
}

export interface SeatDocumentOptions {
  /** Probed, never assumed. `DOCUMENTS_NOT_PROBED` degrades with a named reason. */
  readonly capability: DocumentCapability;
  /** Per-document display cap for the text fallback. */
  readonly promptChars?: number;
  /** Per-document native budget in DECODED bytes. Defaults to the intake's. */
  readonly nativeBudgetBytes?: number;
  /** Injected so the unreadable-bytes branch is reachable without a real PDF. */
  readonly readBytes?: (path: string, maxBytes: number) => Buffer | null;
  /** Injected so extraction is reachable without poppler and without a file. */
  readonly extract?: (
    path: string,
    mediaType: string,
    capability: DocumentCapability,
  ) => Promise<ExtractedDocument>;
}

/**
 * Read each attached document off disk and produce what the seat needs.
 *
 * BOTH HALVES ARE ALWAYS BUILT, AND THE EXTRACTION IS NOT WASTED WORK EVEN FOR A
 * PDF THAT WILL GO NATIVE. The text is the fallback the per-call budget in
 * {@link planSeatDocuments} may need, and that decision is taken later, against
 * the SUM of every document — so a document arriving here without its text would
 * be a document that can only be dropped. The cost is one `pdftotext` per PDF,
 * measured in milliseconds, against a seat call measured in tens of seconds.
 *
 * A SCANNED PDF DOES NOT PRODUCE A CONTRADICTION. Extraction of an image-only
 * PDF degrades and `documentPromptText` renders "IT COULD NOT BE READ" — but
 * that text is only ever appended for documents NOT sent natively, so a scan
 * inside budget travels as bytes with no "could not be read" line attached, and
 * a scan over budget travels as that line, which is then true.
 *
 * NO HOST PATH REACHES THE SEAT. `label` is `ExtractedDocument.label`, which is
 * the redacted basename — the same value `documentPromptText` prints, so the two
 * halves name the document identically.
 *
 * NEVER THROWS ON A FILE. `extractDocumentText` reports every failure as a named
 * degradation rather than an exception, and the byte read is guarded: an
 * unreadable, empty or oversized file yields `block: null` with the reason
 * carried in {@link SeatDocument.nativeDeclined}, never a thrown error that would
 * take down a spec phase over an attachment.
 */
export async function seatDocumentsFor(
  attached: readonly AttachedDocument[],
  options: SeatDocumentOptions,
): Promise<readonly SeatDocument[]> {
  const promptChars = options.promptChars ?? DEFAULT_DOCUMENT_PROMPT_CHARS;
  const nativeBudgetBytes = options.nativeBudgetBytes ?? MAX_NATIVE_PDF_BYTES;
  const readBytes = options.readBytes ?? readBoundedFile;
  const extract = options.extract ?? extractDocumentText;

  const documents: SeatDocument[] = [];
  for (const document of attached) {
    const extracted = await extract(document.path, document.mediaType, options.capability);
    const text = documentPromptText(extracted, promptChars);

    if (document.mediaType !== "application/pdf") {
      documents.push({
        label: extracted.label,
        mediaType: document.mediaType,
        block: null,
        text,
        nativeDeclined: null,
      });
      continue;
    }

    const bytes = readBytes(document.path, nativeBudgetBytes);
    if (bytes === null) {
      documents.push({
        label: extracted.label,
        mediaType: document.mediaType,
        block: null,
        text,
        nativeDeclined:
          `its bytes could not be read within the ${String(nativeBudgetBytes)}-byte native budget ` +
          "(missing, empty, or larger than the budget), so it travels as extracted text",
      });
      continue;
    }

    // `extension` is required by `DecodedDocument` and unread by
    // `nativeDocumentBlock`; it is spelled correctly rather than left blank so a
    // future reader does not take it for a placeholder.
    const decision = nativeDocumentBlock(
      { ok: true, mediaType: document.mediaType, extension: "pdf", bytes },
      { title: extracted.label, budgetBytes: nativeBudgetBytes },
    );
    documents.push({
      label: extracted.label,
      mediaType: document.mediaType,
      text,
      ...(decision.kind === "native"
        ? { block: decision.block, nativeDeclined: null }
        : { block: null, nativeDeclined: decision.detail }),
    });
  }
  return documents;
}

/**
 * Read a whole file, but only if it is small enough to want.
 *
 * THE SIZE IS CHECKED BEFORE THE READ, not after: `readFileSync` on a path this
 * function did not choose is unbounded memory, and the budget is exactly the
 * point at which the bytes stop being useful anyway. `null` covers every failure
 * — missing, unreadable, empty, oversized — because the caller's next step is
 * the same for all four, and the distinction that matters (there is no block)
 * is carried in the reason it attaches.
 */
function readBoundedFile(path: string, maxBytes: number): Buffer | null {
  try {
    const size = statSync(path).size;
    if (size === 0 || size > maxBytes) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export interface SubscriptionCallerOptions {
  readonly budget: BudgetPolicy;
  readonly ceiling?: SpendCeiling;
  readonly onEvent?: (event: SpendEvent) => void;
  /** Working directory for the CLI subprocess. Keep it off the workspace. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Notified whenever the provider reports rate-limit state. */
  readonly onRateLimit?: (state: RateLimitState) => void;
  readonly abortController?: AbortController;
  /**
   * Documents EVERY call this seat makes will carry. Absent means the
   * pre-document path, byte for byte.
   */
  readonly documents?: readonly SeatDocument[];
  /** Override {@link DEFAULT_SEAT_NATIVE_BASE64_CHARS}. */
  readonly nativeBudgetBase64Chars?: number;
  /** The SDK's `query`, unless a test supplies a stream. */
  readonly startQuery?: SeatSessionFactory;
}

/** Environment for the base constructor: process env plus the one sentinel. */
export function sentinelEnv(envKeyName: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, [envKeyName]: SUBSCRIPTION_SENTINEL };
}

export class SubscriptionSeatCaller extends AnthropicSeatCaller {
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #onRateLimit: ((state: RateLimitState) => void) | null;
  readonly #abortController: AbortController | null;
  readonly #plan: SeatDocumentPlan;
  readonly #startQuery: SeatSessionFactory;
  #tokens: TokenTotals = zeroTokens("anthropic");
  #rateLimit: RateLimitState = NOT_RATE_LIMITED;
  #calls = 0;
  #documentCalls = 0;

  constructor(seat: AnthropicSeat, options: SubscriptionCallerOptions) {
    const base = options.env ?? process.env;
    super(seat, {
      budget: options.budget,
      env: sentinelEnv(seat.envKeyName, base),
      ...(options.ceiling === undefined ? {} : { ceiling: options.ceiling }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    this.#cwd = options.cwd;
    // THE SUBPROCESS NEVER SEES A METERED CREDENTIAL. The sentinel above is
    // only for the base class's own credential check; the CLI must fall
    // through to its subscription login, and it will not if it finds a key.
    this.#env = subscriptionSubprocessEnv(base);
    this.#onRateLimit = options.onRateLimit ?? null;
    this.#abortController = options.abortController ?? null;
    this.#plan = planSeatDocuments(
      options.documents ?? [],
      options.nativeBudgetBase64Chars ?? DEFAULT_SEAT_NATIVE_BASE64_CHARS,
    );
    this.#startQuery = options.startQuery ?? query;
  }

  /** Token counts for every call this seat has made. Never a cost. */
  get tokens(): TokenTotals {
    return this.#tokens;
  }

  get callCount(): number {
    return this.#calls;
  }

  get rateLimit(): RateLimitState {
    return this.#rateLimit;
  }

  /** What every call carries, and why each document travels the way it does. */
  get documentPlan(): SeatDocumentPlan {
    return this.#plan;
  }

  /**
   * Calls DISPATCHED carrying the attachment — incremented before the stream is
   * drained, so a call that then fails still counts. That is the honest side to
   * be wrong on for a cost figure: the bytes left this process either way.
   */
  get documentCalls(): number {
    return this.#documentCalls;
  }

  /**
   * The factory this caller will use. EXPOSED SO THE DEFAULT CAN BE PINNED: a
   * default argument can be swapped for a stub, and a test that only ever
   * constructs the caller with its own stub would never notice.
   */
  get startQuery(): SeatSessionFactory {
    return this.#startQuery;
  }

  /**
   * One authoring or audit call, over the subscription CLI.
   *
   * The request is the bake-off's own `SeatCallRequest`, unaltered:
   *   - `system` becomes the SDK's `systemPrompt` as a plain string, which
   *     REPLACES the claude_code preset. The authoring prompt is a frozen
   *     constant and the whole point is that the spec seat sees it and nothing
   *     else.
   *   - `userTurns` are joined into the prompt in order.
   *   - `jsonSchema`, when present, becomes `outputFormat: {json_schema}`. It
   *     is applied, not dropped: a schema silently discarded here would turn
   *     into "the model keeps returning unparseable suites" three layers up.
   *   - `maxOutputTokens` has no SDK equivalent and is NOT silently ignored —
   *     it is enforced after the fact by the caller's own truncation check
   *     (`stop_reason`), which is what spec-agent already keys off.
   *
   * `tools: []` and `settingSources: []` are load-bearing. The spec seat must
   * be a structurally separate agent with no shared history and no access to
   * any implementation (doc 03 section 7.4); a spec seat that could read the
   * workspace, or that inherited the owner's CLAUDE.md, is not that agent.
   *
   * ATTACHED DOCUMENTS RIDE ON EVERY CALL, INCLUDING REGENERATIONS. The plan is
   * fixed at construction and {@link seatPrompt} rebuilds the prompt per call,
   * so authoring attempt 1 and authoring attempt 3 see the same attachment. That
   * is the point — a regeneration that lost the document would author its
   * replacement suite from the ticket text alone while the log still said a
   * document was attached — and it is also the cost:
   * {@link DEFAULT_SEAT_NATIVE_BASE64_CHARS} names the multiplier.
   *
   * `options` IS UNTOUCHED BY DOCUMENTS. Only `prompt` changes shape; nothing
   * about a document is expressible as an SDK option, and the no-document path
   * therefore passes the identical option object it always did.
   */
  override async call(request: SeatCallRequest): Promise<SeatCallResult> {
    if (request.userTurns.length === 0) {
      throw new BakeoffError(
        "invalid_usage_shape",
        "a seat call needs at least one user turn",
        "Pass the ticket brief (and any regeneration feedback) as user turns.",
      );
    }

    const startedAt = new Date().toISOString();

    // The dollar ceiling cannot fire on a subscription (worst case is 0), but
    // this call still enforces the WALL-CLOCK boundary, which can.
    const decision = this.ceiling.checkBeforeCall(0, request.purpose);
    this.ceiling.assertAllowed(decision, request.purpose);

    const abortController = this.#abortController ?? new AbortController();
    const options: Options = {
      abortController,
      cwd: this.#cwd,
      model: this.seat.modelId,
      effort: this.seat.effort,
      systemPrompt: request.system,
      tools: [],
      settingSources: [],
      maxTurns: seatMaxTurns(this.#env),
      includePartialMessages: false,
      env: { ...this.#env },
      ...(request.jsonSchema === null
        ? {}
        : { outputFormat: { type: "json_schema" as const, schema: request.jsonSchema } }),
    };

    let text = "";
    let structured: unknown;
    let stopReason: string | null = null;
    let tokens = zeroTokens("anthropic");
    let thinkingTokens: number | null = null;
    let failure: string | null = null;

    // BUILT PER CALL, NOT PER CALLER. An async generator is single-use; a
    // prompt built once and reused would deliver the document to the first
    // attempt and an empty message to every regeneration after it.
    const prompt = seatPrompt(request, this.#plan);
    if (this.#plan.notes.length > 0) this.#documentCalls += 1;

    try {
      const session = this.#startQuery({ prompt, options });
      for await (const message of session) {
        if (message.type === "assistant") {
          text += assistantText(message);
        } else if (message.type === "rate_limit_event") {
          this.#noteRateLimit(rateLimitFrom(message.rate_limit_info));
        } else if (message.type === "result") {
          stopReason = message.stop_reason;
          tokens = extractTokens(message.usage);
          thinkingTokens = readThinkingTokens(message.usage);
          if (message.subtype === "success") {
            structured = message.structured_output;
            if (text.length === 0) text = message.result;
          } else {
            failure = `${message.subtype}: ${resultErrorText(message)}`;
          }
        }
      }
    } catch (error) {
      throw this.#asCallError(error, request.purpose);
    }

    this.#tokens = addTokens(this.#tokens, tokens);
    this.#calls += 1;

    if (failure !== null) {
      throw new SeatCallError(
        `the ${this.seat.role} seat (${this.seat.modelId}) failed during "${request.purpose}": ` +
          redactText(failure).text,
        null,
        this.#rateLimit.limited
          ? "Rate limited. The 5-hour rolling window or the weekly cap is exhausted. This is an " +
            "expected state on a subscription, not a fault: wait for the window to reset and resume " +
            "the run, which continues the same session rather than starting over."
          : failure.startsWith("error_max_turns")
            ? `The seat hit its turn cap of ${String(seatMaxTurns(this.#env))}. The seat has no tools, ` +
              "so the turns are most likely the CLI re-asking after a response that did not validate " +
              `against the output schema. Raise ${SEAT_MAX_TURNS_ENV} and resume the run; if it keeps ` +
              "hitting the cap, the suite for this ticket does not fit the schema and the ticket text " +
              "is the thing to sharpen."
            : "Read the message above. If every authoring call fails on the output schema, retry with " +
              "structuredOutput disabled: the response then comes back as free-form text and " +
              "spec-agent's own JSON extractor reads the object out of it.",
        this.#rateLimit.limited,
      );
    }

    // Prefer the schema-validated object when one was requested and returned.
    // spec-agent parses text, so a structured result is re-serialised rather
    // than handed over as an object — same parse path, one less special case.
    const responseText = structured === undefined ? text : JSON.stringify(structured);

    return {
      text: responseText,
      stopReason,
      usage: subscriptionUsage(this.seat as AnthropicSeat, tokens, thinkingTokens),
      pricingBasis: subscriptionPricingBasis(this.seat.modelId, startedAt),
      precall: decision,
      // No `count_tokens` call is made: there is no ceiling for it to protect,
      // and it would spend quota to compute a number nothing consumes.
      inputEstimateMeasured: false,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  }

  /**
   * Guard against a future edit reintroducing a base-class network path.
   *
   * The base class holds an `Anthropic` client built from the sentinel. Nothing
   * may use it. This cannot detect the call statically, so it is asserted where
   * it matters: after a run, `usage()`/`hasUsage` on the base class must still
   * be empty, because only the base `call()` populates them.
   */
  assertUnused(): void {
    if (this.hasUsage) {
      throw new BakeoffError(
        "invalid_usage_shape",
        "the base AnthropicSeatCaller recorded usage, which means a real API call was dispatched " +
          "with the placeholder credential",
        "A code path in AnthropicSeatCaller other than the overridden call() reached the network. " +
          "Find it and route it through the subscription SDK; the dashboard must never require or " +
          "use an API key.",
      );
    }
  }

  #noteRateLimit(state: RateLimitState): void {
    this.#rateLimit = state;
    if (this.#onRateLimit !== null) this.#onRateLimit(state);
  }

  #asCallError(error: unknown, purpose: string): Error {
    if (error instanceof BakeoffError || error instanceof SeatCallError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const rateLimited = /rate.?limit|429|usage limit/i.test(message);
    if (rateLimited) this.#noteRateLimit({ limited: true, retryAfterSec: null, kind: null, utilization: null });
    return new SeatCallError(
      `the ${this.seat.role} seat (${this.seat.modelId}) call "${purpose}" failed: ${redactText(message).text}`,
      null,
      rateLimited
        ? "Rate limited. Wait for the window to reset and resume the run."
        : "The Claude CLI subprocess failed. Check `claude auth status` — a session that expired " +
          "mid-run presents exactly like this. No API key is involved and none should be set.",
      rateLimited,
    );
  }
}

function readThinkingTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const details = (usage as { output_tokens_details?: unknown }).output_tokens_details;
  if (typeof details !== "object" || details === null) return null;
  const thinking = (details as { thinking_tokens?: unknown }).thinking_tokens;
  return typeof thinking === "number" && Number.isFinite(thinking) ? thinking : null;
}

/** A fresh ceiling for one ticket's authoring job. */
export function newAuthoringCeiling(budget: BudgetPolicy, onEvent?: (event: SpendEvent) => void): SpendCeiling {
  return new SpendCeiling(budget, onEvent === undefined ? {} : { onEvent });
}
