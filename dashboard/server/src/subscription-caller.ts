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
 * ATTACHED REFERENCE IMAGES, ADDED 2026-08-02, AND WHAT IS PROVEN ABOUT THEM.
 * The owner's instruction was that reference images "need to be analysed and seen
 * not quizzed by me as they are visual reference". Before this, the spec and plan
 * seats could only ASK about an image, because the only channel into them was a
 * string. Images now travel the same way documents do — {@link SeatImage}s become
 * base64 `image` content blocks in the same streamed user message — and for the
 * same reason: `tools: []` does not block it because an image is CONTENT, not a
 * tool call. THE SEAT IS STILL GIVEN NO TOOLS. It cannot open a file and must not
 * be able to; carrying pictures as content is what makes the capability
 * unnecessary rather than what relaxes the boundary.
 *
 * THE MEASUREMENT, TAKEN THIS SESSION AND BY THIS FILE'S OWN LIVE TEST rather
 * than by a stub: a `Base64ImageSource` PNG was pushed through
 * `query({ prompt: <AsyncIterable<SDKUserMessage>>, options })` against the real
 * CLI subprocess with THIS seat's options (`tools: []`, `settingSources: []`)
 * AND `outputFormat: {type: "json_schema"}`, and came back result subtype
 * `success` having correctly named which half of the image was red and which was
 * blue. That closes the specific gap the document paragraph below leaves open:
 * streaming input + content block + structured output had never been run
 * together, and every real authoring call carries that output format. See
 * `subscription-caller.live.test.ts`, which is skipped unless
 * DASHBOARD_LIVE_SMOKE=1.
 *
 * AND THE NEGATIVE CONTROL FOR IT, RUN THE SAME SESSION, because a live test that
 * cannot fail proves nothing. The identical call with `images: []` and everything
 * else unchanged — same system prompt, same question, same schema — came back
 * left = "blue" and the assertion FAILED. The passing answer therefore came from
 * the image block, and not from the system prompt, the filename, or a lucky
 * guess: without the picture the seat has nothing to read and answers wrongly.
 *
 * TWO THINGS THAT MEASUREMENT DOES NOT ESTABLISH:
 *   - HOW LARGE an image may be, or how many. The probe sent ONE 193-byte PNG.
 *     {@link MAX_SEAT_IMAGE_BYTES} and {@link DEFAULT_SEAT_IMAGE_BASE64_CHARS}
 *     are chosen budgets, not discovered ceilings, and say so.
 *   - THAT A SEAT WITH IMAGES AUTHORS BETTER CRITERIA. Nothing here grades the
 *     criteria; this file only puts the picture in front of the seat.
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
 *
 * THE IMAGE CHAIN IS SHORTER, AND SINCE 2026-08-02 IT IS CONNECTED AT ONE END.
 * `orchestrator.ts#planSeat` now calls {@link seatImagesFor} on the run's
 * manifest and passes `images` to the PLAN seat's caller, and `plan-seat.ts`
 * tells that seat to look at them (its old "YOU CANNOT OPEN THEM" branch is
 * deleted). THE SPEC SEAT IS DELIBERATELY UNCHANGED and still constructs without
 * `images`, for the reason `plan-seat.ts`'s header records: what reaches it is
 * the plan phase's output — the owner's own sentences and criteria written in
 * words a text-only grader can check — which is traceable in a way a criterion
 * authored from a picture its own auditor cannot see would not be.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

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
import { redactForPersistence, redactText } from "bakeoff/dist/redact.js";
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

/* -------------------------------------------------------------------------
 * The output ceiling: sending it, and recognising it being hit
 * ---------------------------------------------------------------------- */

/**
 * The ONLY lever that governs a seat call's output budget on this path.
 *
 * `Options` in `@anthropic-ai/claude-agent-sdk@0.3.220` carries no output-token
 * field — the `maxOutputTokens` at `sdk.d.ts:1273` is a member of `ModelUsage`,
 * i.e. a report of what was used, not a control. The CLI reads this variable
 * (declared as an int in the SDK's own env schema, and named in the CLI's own
 * over-length error text), and until 2026-08-04 nothing in this repository set
 * it, so every seat ran at the CLI's 64,000 default while `plan-seat.ts`,
 * `judge.ts` and `spec-types.ts` each declared a different number that was only
 * ever checked AFTER the response came back.
 *
 * IT IS SET AFTER `subscriptionSubprocessEnv`, DELIBERATELY. That function is a
 * SUBTRACTION, not an allowlist (`subprocess-env.ts` says so and
 * `STRIPPED_ENV_NAMES` does not contain this name), so the value survives
 * and no metered credential is re-added by setting it.
 */
export const MAX_OUTPUT_TOKENS_ENV = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

/**
 * The subprocess environment for ONE call, carrying that call's own ceiling.
 *
 * Per CALL and not per caller, because the ceiling is a property of the request:
 * `plan-seat.ts` and `judge.ts` share a construction pattern and ask for wildly
 * different budgets, and a seat could in principle make both kinds of call.
 *
 * A NON-POSITIVE OR NON-INTEGER VALUE LEAVES THE VARIABLE UNSET rather than
 * writing garbage the CLI would parse as NaN and silently ignore. The base class
 * rejects such a request outright (`anthropic-seat.ts` validates it), but this
 * override does not call the base `call()`, so the degradation is stated here:
 * the CLI's own default applies and the run continues.
 */
export function seatCallEnv(base: NodeJS.ProcessEnv, maxOutputTokens: number): NodeJS.ProcessEnv {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) return { ...base };
  return { ...base, [MAX_OUTPUT_TOKENS_ENV]: String(maxOutputTokens) };
}

/**
 * The SDK's own name for an over-length turn: a declared member of
 * `SDKAssistantMessageError` (`sdk.d.ts:2901`), set by the CLI on the synthetic
 * assistant frame it emits when the API stream stops on `max_tokens`.
 */
const SDK_OVERFLOW_ERROR = "max_output_tokens";

/** The API's stop reason for the same event, and what `spec-agent` keys off. */
export const OVERFLOW_STOP_REASON = "max_tokens";

/**
 * The CLI's own complaint, matched on two independent fragments.
 *
 * PROSE MATCHING IS A FALLBACK AND IT IS HERE ON EVIDENCE, NOT ON PRINCIPLE. The
 * only shape ever OBSERVED in this repository is the one that killed run
 * `run-2026-08-04T11-08-10-487Z-162b186d`, and it arrived as prose: a result
 * frame with `is_error` whose text the SDK's reader then re-threw as
 * `Error("Claude Code returned an error result: API Error: Claude's response
 * exceeded the 64000 output token maximum. To configure this behavior, set the
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.")`. By the time it reaches
 * the `catch` there is no structured field left on it at all.
 *
 * So both alternatives are matched: the sentence, and the variable name the
 * sentence names. The number in the middle is deliberately not anchored — it is
 * whatever ceiling was in force, which is now ours to set.
 */
const OVERFLOW_PROSE = /output token maximum|CLAUDE_CODE_MAX_OUTPUT_TOKENS/i;

/** True when a message, error text or result blob is the over-length failure. */
export function isOutputOverflowText(text: string): boolean {
  return OVERFLOW_PROSE.test(text);
}

/** True when an assistant frame carries the SDK's structured overflow marker. */
export function isOutputOverflowFrame(message: SDKMessage): boolean {
  if (message.type !== "assistant") return false;
  return (message as { error?: unknown }).error === SDK_OVERFLOW_ERROR;
}

/**
 * The shapes a reset instant arrives in when the refusal comes back as PROSE.
 *
 * ─── WHY THERE IS A TEXT PARSER HERE AT ALL ───
 *
 * A refusal has two routes into this file. The good one is the SDK's structured
 * `rate_limit_info` frame, read by `rateLimitFrom` and carrying a real reset
 * instant. The other is a THROW: the CLI reports the refusal on a result frame
 * with `is_error`, the SDK's reader re-throws it as a plain `Error`, and by the
 * time it reaches `#asCallError` there is no structured field left on it — only
 * the sentence. That path wrote `retryAfterSec: null` unconditionally until
 * 2026-08-09, so a refusal arriving this way could never arm a wait: `recovery.ts`
 * stopped on `no_retry_after` and the run sat until a human pressed Resume,
 * however short the window actually was.
 *
 * ─── THE PATTERNS ARE FROM THE BINARY, NOT FROM IMAGINATION ───
 *
 * No refusal has EVER been recorded on this machine (`rate_limited = 0` on all
 * four rows in `runs.db`), so there is no observed sample to fit. Inventing
 * shapes would be worse than nothing, so these come from the templates present
 * in the CLI the seat actually runs
 * (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, grepped
 * 2026-08-09): `Retry after {retry_after}s.` and `Retry-After: ${e.retryAfter}`,
 * plus the `retry_after` JSON key an API error body carries. `try again in a
 * moment` is also in that binary and names no number, which is exactly the case
 * the fallback in `recovery.ts` exists for.
 *
 * NOTHING HERE INVENTS A NUMBER. A text with no reset in it returns `null`, and
 * `null` still means "the provider named no instant".
 */
const RETRY_AFTER_PATTERNS: readonly { readonly re: RegExp; readonly unitSeconds: number }[] = [
  // `Retry-After: 60`, `retry_after: 60`, `"retry_after":60` — the header and
  // the JSON key, both in seconds.
  { re: /retry[-_ ]?after"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i, unitSeconds: 1 },
  // `Retry after 60s.`
  { re: /retry\s+after\s+(\d+(?:\.\d+)?)\s*s\b/i, unitSeconds: 1 },
  { re: /try again in (\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i, unitSeconds: 1 },
  { re: /try again in (\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i, unitSeconds: 60 },
  { re: /try again in (\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, unitSeconds: 3600 },
];

/**
 * Seconds until the window reopens, as the provider itself stated them in the
 * text — or `null` when it stated nothing.
 *
 * ROUNDED UP, NEVER DOWN. A wait one second short of the window re-enters the
 * same refusal and spends one of the three bounded continuations to learn
 * nothing. `Math.ceil` on a fractional reading is the cheap side of that.
 */
export function parseRetryAfterSeconds(text: string): number | null {
  for (const { re, unitSeconds } of RETRY_AFTER_PATTERNS) {
    const match = re.exec(text);
    if (match === null) continue;
    const raw = Number(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    return Math.ceil(raw * unitSeconds);
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Progress: the only liveness signal a seat with no tools has
 *
 * THE RUN THIS SECTION IS ABOUT IS THE SAME ONE THE SECTION ABOVE IS ABOUT.
 * `run-2026-08-04T11-08-10-487Z-162b186d` spent 51 minutes in the spec phase and
 * recorded 61 events in total across the whole run — 36 `log`, 11 `status`, 9
 * `rate_limit`, 4 `phase`, 1 `verdict`. Zero `tool`. Zero `graph_*`. A run that
 * reached the build recorded 388. The spec phase is not under-instrumented; this
 * caller emits NOTHING, and the seat it drives has `tools: []`, so there is not
 * even a tool call for something else to notice.
 *
 * WHICH LEAVES EXACTLY ONE SIGNAL: the text the model is streaming. The SDK will
 * forward it as `SDKPartialAssistantMessage` (`type: "stream_event"`,
 * `sdk.d.ts:4150`) when `includePartialMessages` is set, which this file has
 * hardcoded to `false` since it was written.
 *
 * IT IS NOT THINKING AND MUST NOT BE PRESENTED AS THINKING. Measured across the
 * local transcript corpus: 7,037 `thinking` blocks over four models, of which
 * ZERO carry any text — `thinking` is `""` and the `signature` beside it is an
 * encrypted blob no SDK option decrypts. `thinking_delta` frames are therefore
 * ignored below rather than rendered empty.
 *
 * NOTHING HERE GIVES THE SEAT A CAPABILITY. The only option that changes is
 * `includePartialMessages`, which is a REPORTING switch on the host side of the
 * pipe: `tools` and `settingSources` stay `[]`, the prompt is unchanged, and the
 * seat cannot observe that anyone is listening. That boundary is the reason this
 * seat exists (doc 03 §7.4) and the progress path must not become a hole in it.
 * ---------------------------------------------------------------------- */

/**
 * How often a call may report, at most.
 *
 * THE NUMBER IS CHOSEN AGAINST THE RUN THAT FAILED, NOT AGAINST A BUILD. 30
 * seconds means a 50-minute call reports at most `1 + floor(3000/30) = 101`
 * times — the leading report plus one per interval. The dead run's ENTIRE event
 * stream was 61 rows, so this is the same order of magnitude as the run it is
 * making visible rather than a new dominant source of rows. Against the raw
 * signal it is a reduction of roughly 200-300x: a 64,000-token response arrives
 * as one `content_block_delta` per streamed chunk, which at 2-3 tokens a chunk
 * is 21,000-32,000 frames.
 *
 * FASTER WAS CONSIDERED AND REFUSED. A 15-second interval (the SSE heartbeat's
 * period, `bus.ts`) would put 201 rows on a single call — 3.3x the whole failed
 * run — into the generic `log` channel, for a signal whose entire job is "it is
 * still alive and roughly here". Liveness does not need 200 samples.
 */
export const SEAT_PROGRESS_INTERVAL_MS = 30_000;

/**
 * How much of the stream one report carries, and the size of the first one.
 *
 * TWO JOBS, ONE NUMBER, AND THAT IS DELIBERATE. It caps the excerpt, and it is
 * also the threshold for the LEADING report: the first report fires as soon as
 * this many characters have arrived instead of waiting out the first interval,
 * so the black box breaks in about a second rather than in thirty. Reporting on
 * the very first delta instead would print `latest: "I"`, which is liveness with
 * nothing attached to it.
 */
export const SEAT_PROGRESS_CHARS = 240;

/**
 * How much already-reported text is carried forward AS REDACTION CONTEXT.
 *
 * THE RULE THIS EXISTS TO HONOUR IS WRITTEN IN `orchestrator.ts`: "a credential
 * split across two writes cannot be matched by a regex applied to each write
 * separately, which is why `redact.ts` ships no per-chunk function at all". A
 * coalescer that redacted each report's buffer in isolation would be exactly the
 * per-chunk redact that file forbids — the report boundary is a write boundary.
 *
 * `ReassemblingRedactor`, the sanctioned answer, CANNOT BE USED HERE and the
 * reason is arithmetic rather than taste: it withholds `OVERLAP_WINDOW_CHARS`
 * (16,384) of tail before flushing anything, which is 68x this excerpt and
 * roughly 80 seconds of a model's output. A liveness signal that reports nothing
 * for the first eighty seconds is not a liveness signal. That class exists for the
 * build LOG, which is explicitly allowed to lag the live stream.
 *
 * SO THE MITIGATION IS PARTIAL AND ITS RESIDUE IS NAMED. Carrying 512 characters
 * of already-streamed text into the next report's redaction window means a
 * credential straddling a report boundary is matched — in the report AFTER the
 * split. The half that ended the EARLIER report was shown before its other half
 * existed, and no amount of buffering fixes that without withholding the tail.
 * 512 exceeds every span in `CREDENTIAL_RULES` except a PEM block and an
 * unusually long JWT.
 *
 * WHAT MAKES THE RESIDUE SMALL RATHER THAN ACCEPTABLE-BY-ASSERTION: this seat has
 * `tools: []`. It cannot read a file, run a command or see an environment
 * variable, so a credential can only reach its output by being in the ticket or an
 * attached document and then reproduced verbatim — in which case it is already in
 * the run's own ticket row and already on the owner's screen.
 */
export const SEAT_PROGRESS_CARRY_CHARS = 512;

/** One coalesced progress report from a seat call in flight. */
export interface SeatProgress {
  /**
   * The `SeatCallRequest.purpose` of the call this is about.
   *
   * NOT RENDERED BY THE ORCHESTRATOR TODAY, and kept anyway: it is the only field
   * that distinguishes "authoring attempt 1" from "attempt 3" for a consumer that
   * wants to, and a sink that has to be told which call it is listening to is a
   * sink that will eventually be told wrong.
   */
  readonly purpose: string;
  /**
   * The NEWEST {@link SEAT_PROGRESS_CHARS} characters of the stream, redacted and
   * whitespace-collapsed.
   *
   * A ROLLING WINDOW OVER THE CALL, not "everything since the last report". The
   * TAIL and not the head: the question this answers is "what is it doing now",
   * and on a seat streaming a JSON suite the tail names the criterion currently
   * being written. A slow interval that produced only ten characters therefore
   * still shows 240 — the ten new ones with the previous 230 for context — rather
   * than ten characters of nothing.
   */
  readonly text: string;
  /** Characters streamed by this call so far, in total. Never reset. */
  readonly chars: number;
  /** Wall clock since the call was dispatched. */
  readonly elapsedMs: number;
}

export type SeatProgressSink = (progress: SeatProgress) => void;

/**
 * The text of one partial-assistant frame — and nothing else.
 *
 * READ DEFENSIVELY, BY SHAPE. `SDKPartialAssistantMessage.event` is typed as
 * `BetaRawMessageStreamEvent`, a union owned by a different package that gains
 * members between releases; narrowing by field is what keeps an unknown future
 * delta type folding to `""` instead of throwing inside the stream loop.
 *
 * ONLY `text_delta`. `thinking_delta` is skipped for the measured reason in this
 * section's header — 0 of 7,037 thinking blocks carried any text — and skipping
 * it here rather than filtering later means the character count never claims
 * progress that has no text behind it.
 */
export function partialAssistantText(message: SDKMessage): string {
  if (message.type !== "stream_event") return "";
  const event = (message as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return "";
  if ((event as { type?: unknown }).type !== "content_block_delta") return "";
  const delta = (event as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return "";
  if ((delta as { type?: unknown }).type !== "text_delta") return "";
  const text = (delta as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** Every run of whitespace becomes one space: a log row is one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The last `max` characters, marked when something was dropped. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/**
 * Token-granularity deltas in, a bounded number of reports out.
 *
 * ITS OWN CLASS BECAUSE THE BOUND IS THE FEATURE. A throttle written inline in
 * the stream loop is a throttle whose only test is a 30-second one, and a
 * progress path that emitted per delta would put tens of thousands of rows into
 * a run's durable event table — the failure mode is not "noisy UI", it is a
 * SQLite table and an SSE queue (`bus.ts`'s 4 MiB per-client budget) sized for a
 * few hundred rows receiving thirty thousand.
 *
 * THE CLOCK IS INJECTABLE AND THE INTERVAL IS NOT A CONSTANT HERE, so the bound
 * can be measured rather than waited out. `subscription-caller.progress.test.ts`
 * feeds 2,000 deltas and asserts 1 report.
 *
 * REDACTION RUNS OVER A WINDOW THAT OUTLIVES THE REPORT, AND BEFORE THE CLIP.
 * `redactText` is the same function this file already applies to a failure
 * message. It is given `carry + pending` rather than `pending`, so a credential
 * split across a REPORT boundary is still matched — the boundary this class
 * creates is a write boundary, and `orchestrator.ts` states plainly why redacting
 * each write separately is wrong. Read {@link SEAT_PROGRESS_CARRY_CHARS} for what
 * that fixes and, more importantly, for the half it does not.
 */
export class SeatProgressCoalescer {
  readonly #purpose: string;
  readonly #sink: SeatProgressSink;
  readonly #intervalMs: number;
  readonly #chars: number;
  readonly #carryChars: number;
  readonly #now: () => number;
  readonly #startedAt: number;
  /** Already-reported text, held only so the redactor can see across the seam. */
  #carry = "";
  #pending = "";
  #total = 0;
  #reports = 0;
  #lastAt: number;

  constructor(
    purpose: string,
    sink: SeatProgressSink,
    options: {
      readonly intervalMs?: number;
      readonly chars?: number;
      readonly carryChars?: number;
      /** Test seam. Production passes nothing and gets `Date.now`. */
      readonly now?: () => number;
    } = {},
  ) {
    this.#purpose = purpose;
    this.#sink = sink;
    this.#intervalMs = options.intervalMs ?? SEAT_PROGRESS_INTERVAL_MS;
    this.#chars = options.chars ?? SEAT_PROGRESS_CHARS;
    this.#carryChars = options.carryChars ?? SEAT_PROGRESS_CARRY_CHARS;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#lastAt = this.#startedAt;
  }

  /** How many reports this call has produced. The bound, observable. */
  get reports(): number {
    return this.#reports;
  }

  /**
   * Take one delta. Reports at most once, and only when there is something to
   * say — a report with an empty excerpt would be a row asserting activity that
   * produced no text.
   */
  push(delta: string): void {
    if (delta.length === 0) return;
    this.#pending += delta;
    this.#total += delta.length;
    const now = this.#now();
    const due =
      this.#reports === 0
        ? this.#pending.length >= this.#chars || now - this.#lastAt >= this.#intervalMs
        : now - this.#lastAt >= this.#intervalMs;
    if (!due) return;
    this.#lastAt = now;
    this.#reports += 1;
    // THE WINDOW, NOT THE CHUNK. `#carry` is text this call has already reported;
    // it is here so the redactor can see a credential that straddles the seam,
    // and it doubles as the context that keeps a slow interval's excerpt readable.
    const window = this.#carry + this.#pending;
    const text = tail(oneLine(redactText(window).text), this.#chars);
    this.#carry = window.slice(-this.#carryChars);
    this.#pending = "";
    this.#sink({
      purpose: this.#purpose,
      text,
      chars: this.#total,
      elapsedMs: now - this.#startedAt,
    });
  }
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
 * IMAGES JOIN ON EXACTLY THAT RULE, WHICH IS WHY THEY ARE A THIRD ARGUMENT WITH A
 * DEFAULT RATHER THAN A NEW FUNCTION. An empty image plan contributes an empty
 * `text` and no blocks, so `seatPrompt(request, plan)` means what it has always
 * meant and a seat carrying documents and no images streams exactly the message
 * it did before this argument existed. Streaming is now used when there is at
 * least one block OF EITHER KIND; a seat whose only images were all refused
 * carries their {@link undeliveredImageSection}s on the STRING path, because
 * there is again nothing to stream.
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
  images: SeatImagePlan = NO_SEAT_IMAGES,
): string | AsyncIterable<SDKUserMessage> {
  const turns = request.userTurns.join("\n\n");
  // JOINED IN THIS ORDER, AND EMPTY MEMBERS CONTRIBUTE NOTHING — not an empty
  // line, not a separator. That is what keeps the documents-only string byte
  // for byte what it was before images existed.
  const attached = [plan.text, images.text].filter((section) => section !== "").join("\n");
  const text = attached === "" ? turns : `${turns}\n${attached}`;
  if (plan.blocks.length === 0 && images.blocks.length === 0) return text;
  return oneShotAttachmentMessage(plan.blocks, images.blocks, text);
}

/**
 * One user message: the documents, then the images, then the text.
 *
 * ATTACHMENTS BEFORE TEXT because the text refers to them ("the owner attached
 * …") and because a block trailing the instruction reads as an afterthought to
 * the model in the same way it does to a person. The API imposes no order.
 *
 * DOCUMENTS BEFORE IMAGES IS ARBITRARY BUT FIXED, and nothing is allowed to
 * depend on the absolute position: {@link imageRoster} numbers the IMAGE blocks
 * among themselves ("in the order they appear"), so a prompt carrying two PDFs
 * and three mockups still names mockup 1 as 1. Documents self-label through
 * `block.title` and do not need the ordering at all.
 *
 * A FRESH GENERATOR PER CALL. An async generator is single-use: iterating it
 * twice yields nothing the second time, so a shared instance would send the
 * attachments on the first authoring attempt and an EMPTY prompt on the
 * regeneration. `call()` therefore builds the prompt inside the call, and the
 * tests drive two calls and assert both carried the blocks.
 */
async function* oneShotAttachmentMessage(
  documents: readonly SeatDocumentBlock[],
  images: readonly SeatImageBlock[],
  text: string,
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: [...documents, ...images, { type: "text", text }] },
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

/* -------------------------------------------------------------------------
 * Attached reference images
 * ---------------------------------------------------------------------- */

/**
 * The four image media types, which are the four the intake accepts.
 *
 * NOT A POLICY, THE API'S OWN TYPE. `Base64ImageSource` is declared
 * `media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'`
 * (@anthropic-ai/sdk `resources/messages/messages.d.ts:97`), and
 * `decodeReferenceDataUrl` (ticket-refs.ts:114) accepts exactly
 * `png|jpeg|jpg|webp|gif`. The two sets coincide, so every image the intake lets
 * in has a base64 image form — which is the difference from documents, where
 * only the PDF of nine accepted types has one.
 */
export type SeatImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export const ACCEPTED_SEAT_IMAGE_MEDIA_TYPES: readonly SeatImageMediaType[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * The intake's extension → the media type on the wire.
 *
 * THE EXTENSION IS WHERE THE MEDIA TYPE LIVES, BECAUSE THE MANIFEST DOES NOT
 * RECORD ONE. `ReferenceDocument` carries `mediaType`; `ReferenceImage` is
 * `{path, sha256, bytes}` and nothing more (ticket-refs.ts:127), so an image's
 * type has to be recovered from its path. That is sound rather than a guess:
 * `http.ts:1719` writes `reference-<n>.<ext>` where `ext` comes from
 * `decodeReferenceDataUrl`, which derived it from the data URL's declared type —
 * it is not a client-supplied filename.
 *
 * `jpeg` AND `jpg` BOTH MAP, though the intake only ever writes `jpg`. A path
 * reaching this from anywhere else spelled `.jpeg` is an image the API accepts,
 * and refusing it would be this module lying about the API's own union.
 *
 * WHAT THIS INHERITS AND CANNOT FIX: `decodeReferenceDataUrl` states that it does
 * NOT verify the declared MIME type against the bytes. So an extension here
 * records what the uploader CLAIMED. If the claim is wrong the API rejects the
 * block and it surfaces loudly through `#asCallError`, which is the same bargain
 * `nativeDocumentBlock` takes by trusting `DecodedDocument.mediaType`. Sniffing
 * magic bytes here was rejected deliberately: it would give the seat a different
 * notion of an image's type from the manifest's, with nothing able to reconcile
 * the two.
 */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, SeatImageMediaType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * A base64 image as the API's `image` content block.
 *
 * DECLARED STRUCTURALLY, for the reason {@link NativeDocumentBlock} gives:
 * `@anthropic-ai/sdk` is a TRANSITIVE dependency this package does not declare.
 * The shape is asserted assignable to the real `ImageBlockParam` inside
 * `subscription-caller.images.test.ts`, so SDK drift becomes a compile error.
 *
 * TWO FIELDS THE DOCUMENT BLOCK HAS AND THIS ONE DOES NOT, both load-bearing:
 *
 *   `title`      `ImageBlockParam` (messages.d.ts:610) is `{source, type,
 *                cache_control?}` — there is nowhere to put a filename. The
 *                seat therefore cannot tell which picture is which from the
 *                blocks alone, which is why {@link SeatImagePlan.text} always
 *                carries a roster naming them IN BLOCK ORDER.
 *   `citations`  There is no image equivalent of a page-anchored citation. The
 *                traceability argument for the PDF path — "a criterion that can
 *                name the page it came from" — DOES NOT CARRY OVER. Anything the
 *                seat says about an image is its own description of what it saw,
 *                and the roster text says so to the seat in as many words.
 */
export interface SeatImageBlock {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly media_type: SeatImageMediaType;
    /** Standard base64, no data-URL prefix. The API takes the payload alone. */
    readonly data: string;
  };
}

/**
 * One reference image the owner attached, in the form this seat needs it.
 *
 * THE FIELD IS `declined`, NOT `nativeDeclined`, AND THE RENAME IS THE POINT. A
 * {@link SeatDocument} with no block still travels — as extracted text — so its
 * reason explains a DEMOTION. An image with no block does not travel at all:
 * there is no text form of a picture, and `pdftotext` has no counterpart here.
 * Same vocabulary, different consequence, so a different name rather than a
 * familiar one that would quietly mean something else.
 *
 * `label` IS SEAT-FACING and is the redacted basename, never a host path — the
 * rule `ticket-refs.ts` states for the brief and `documentPromptText` keeps for
 * documents.
 */
export interface SeatImage {
  readonly label: string;
  /** `null` when the extension named no media type this seat can carry. */
  readonly mediaType: SeatImageMediaType | null;
  readonly block: SeatImageBlock | null;
  /**
   * Why there is no block, in the words of whoever decided — or null when a
   * block IS present. Same purpose as {@link SeatDocument.nativeDeclined}: the
   * five refusals ({@link SeatImageReadCode} plus the unsupported type and the
   * per-call budget) have five different fixes, and a note naming the wrong one
   * sends the owner to the wrong file.
   *
   * IT NEVER CONTAINS A HOST PATH. It is rendered into seat-facing text by
   * {@link planSeatImages}, so `readBoundedImage` reports an fs error by its
   * `code` (`ENOENT`, `EACCES`) rather than by its message, whose text embeds
   * the path Node was given.
   */
  readonly declined: string | null;
}

/**
 * The largest ONE image this seat will carry, DECODED.
 *
 * A CHOSEN BUDGET, NOT A DISCOVERED CEILING — the same status
 * {@link DEFAULT_SEAT_NATIVE_BASE64_CHARS} and `MAX_NATIVE_PDF_BYTES` carry, and
 * it is important not to read it as an API limit. Nothing in this session
 * measured how large an image block may be; the probe below sent a 193-byte PNG.
 *
 * THE NUMBER IS SET AGAINST REAL FILES, AND THE FIRST ATTEMPT AT IT WAS WRONG.
 * It was originally 2 MB, justified by the assertion that reference images are
 * "typically a few hundred kilobytes" — an assumption, not a measurement.
 * MEASURED THIS SESSION, the reference PNGs actually sitting in this
 * repository's own `runs/<id>/references/` are 1,961,940, 1,663,665 and 1,289,740
 * bytes, and a retina `screencapture` of this machine's 3600x2338 display is
 * 936,670 bytes. The largest real one was therefore within 4% of the old cap: a
 * page capture a fraction wider would have been refused, and the owner's
 * instruction is that these be SEEN. 4 MB is double the largest measured file,
 * and it is the same per-item ceiling the document path already uses for native
 * bytes (`MAX_NATIVE_PDF_BYTES`), so the two halves of one attachment story
 * agree instead of each picking a number.
 *
 * A NAMED GAP THIS LEAVES OPEN. `MAX_REFERENCE_IMAGE_BYTES` (ticket-refs.ts:96)
 * accepts 8 MB, so an image between 4 and 8 MB is stored, digested into the
 * ticket id, and READ BY THE BUILDER AND THE DESIGN LANE — which are given paths
 * and have tools — while this seat does not get it. The asymmetry is not silent
 * (the seat is told the image exists and is absent, and the run log names it by
 * {@link describeSeatImages}), but it is real. Closing it means raising this
 * number and re-deriving the budget below, not special-casing anything.
 *
 * AN IMAGE OVER IT IS DROPPED, NOT DEMOTED, because there is nothing to demote it
 * to. It is named in {@link SeatImagePlan.notes} and announced to the seat by
 * {@link undeliveredImageSection}.
 */
export const MAX_SEAT_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * How much base64 this seat will carry as IMAGES in ONE call, across ALL images.
 *
 * DERIVED FROM THE PER-IMAGE CAP RATHER THAN CHOSEN AGAIN, exactly as
 * {@link DEFAULT_SEAT_NATIVE_BASE64_CHARS} is derived from `MAX_NATIVE_PDF_BYTES`,
 * so the two cannot drift into disagreeing. Three images' worth: 16,777,218
 * base64 characters, 16 MB.
 *
 * WHY THREE WHEN THE INTAKE ACCEPTS SIX — AND WHY SIX STILL FIT IN PRACTICE.
 * "Three images' worth" is three at the 4 MB per-image CAP, which is twice the
 * largest reference image measured in this repository. Against the real files
 * named on {@link MAX_SEAT_IMAGE_BYTES}, SIX of the biggest (1,961,940 bytes)
 * come to 15,695,520 base64 characters and ALL SIX TRAVEL, with room to spare.
 * The budget therefore bites on the pathological intake — six images averaging
 * over 4 MB, which the route would accept at 8 MB each, i.e. 64 MB of base64 —
 * and not on the intake this feature actually sees. When it does drop one it says
 * which, by name, in three places: the plan's notes, the run log line from
 * {@link describeSeatImages}, and a section in the prompt telling the seat the
 * image exists and is absent.
 *
 * THE COST THIS BOUNDS, WITH THE MULTIPLIER SPELLED OUT, on the same arithmetic
 * `DEFAULT_SEAT_NATIVE_BASE64_CHARS` states: images ride in the USER TURN and
 * `generateAuditedSuite` loops up to three authoring calls plus one truncation
 * retry, so a worst case of FOUR calls each re-sending every byte — ~64 MB of
 * base64 across four calls at this budget. That is a large number and it is meant
 * to be read as one; the alternative was refusing the owner's actual references.
 *
 * NOTHING HAS DRIVEN THE CLI'S STDIN TO THIS SIZE. The live probe sent 260 base64
 * characters. Whether one JSON message of 16 MB is accepted is UNMEASURED, and if
 * it is not, it fails loudly through `#asCallError` rather than silently.
 *
 * IT IS NOT THE ONLY BUDGET IN THE MESSAGE, AND NOTHING ENFORCES THE SUM.
 * Documents may add up to {@link DEFAULT_SEAT_NATIVE_BASE64_CHARS} (5,592,406)
 * on top of this, so the true worst case for one call is 22,369,624 base64
 * characters, ~21.3 MB, and ~85 MB across four calls. That total is stated here
 * rather than bounded because bounding it would mean one shared budget whose
 * outcome depends on which planner ran first — a run where attaching a PDF
 * silently dropped a mockup. Two independent budgets each name what they bound;
 * a reader who needs the envelope adds them.
 */
export const DEFAULT_SEAT_IMAGE_BASE64_CHARS = 3 * Math.ceil((MAX_SEAT_IMAGE_BYTES * 4) / 3);

/**
 * What one call will actually carry in pictures, decided ONCE at construction.
 *
 * DECIDED ONCE FOR THE REASON {@link SeatDocumentPlan} GIVES: `generateSuite`
 * re-calls the same caller for each regeneration attempt, and a plan recomputed
 * per call could differ between attempt 1 and attempt 3 — a suite audited
 * against references the regeneration never saw.
 */
export interface SeatImagePlan {
  /** Image blocks, in the order given, within budget. */
  readonly blocks: readonly SeatImageBlock[];
  /**
   * The labels of {@link blocks}, IN THE SAME ORDER AND THE SAME LENGTH.
   *
   * A FIRST-CLASS FIELD BECAUSE THE CORRESPONDENCE IS THE ONLY LABELLING THERE
   * IS. An image block has no `title`, so this list — rendered into
   * {@link text} — is what tells the seat which picture is which. A test asserts
   * the two arrays stay in lockstep; if they drift the seat is told the second
   * mockup is the first one, which is worse than telling it nothing.
   */
  readonly labels: readonly string[];
  /** The roster naming {@link blocks}, plus a section per image that did NOT travel. */
  readonly text: string;
  /** Exact base64 characters across {@link blocks}. Re-sent on every call. */
  readonly base64Chars: number;
  /** One sentence per image, for the run log. Never empty when images were given. */
  readonly notes: readonly string[];
}

/** The plan for a seat with no images: the pre-image behaviour exactly. */
export const NO_SEAT_IMAGES: SeatImagePlan = Object.freeze({
  blocks: [],
  labels: [],
  text: "",
  base64Chars: 0,
  notes: [],
});

/**
 * Decide, per image, whether it travels — and when it does not, say why.
 *
 * ORDER MATTERS AND IS THE OWNER'S, the same rule {@link planSeatDocuments}
 * states: images are considered in the order given, the ones that fit travel, and
 * nothing is reordered by size. `ticket-refs.ts` already treats the order as the
 * owner's stated priority ("this one first") to the point of folding it into the
 * ticket id, so silently promoting a smaller third image over a larger first one
 * would contradict the identity the run was minted under.
 *
 * NO IMAGE IS EVER SILENTLY DROPPED — the requirement a bounded list has to meet.
 * An image that cannot travel still renders {@link undeliveredImageSection},
 * which tells the seat the attachment exists, that it is absent, and not to guess
 * at it. That branch matters MORE here than for documents: a dropped document
 * still arrives as text, so its silence would cost detail; a dropped image
 * arrives as nothing at all, so its silence would be a prompt that has forgotten
 * an attachment the owner made.
 */
export function planSeatImages(
  images: readonly SeatImage[],
  budgetBase64Chars: number = DEFAULT_SEAT_IMAGE_BASE64_CHARS,
): SeatImagePlan {
  if (images.length === 0) return NO_SEAT_IMAGES;

  const blocks: SeatImageBlock[] = [];
  const labels: string[] = [];
  const sections: string[] = [];
  const notes: string[] = [];
  let base64Chars = 0;

  for (const image of images) {
    const size = image.block === null ? 0 : image.block.source.data.length;
    if (image.block !== null && base64Chars + size <= budgetBase64Chars) {
      blocks.push(image.block);
      labels.push(image.label);
      base64Chars += size;
      notes.push(
        `${image.label} (${image.block.source.media_type}): sent as an image block, ` +
          `${String(size)} base64 chars`,
      );
      continue;
    }

    const reason =
      image.block === null
        ? (image.declined ?? "no image block was supplied for it and no reason was given with it")
        : `carrying it would put ${String(base64Chars + size)} base64 chars of images into EVERY call ` +
          `this seat makes and the per-call budget is ${String(budgetBase64Chars)}, so it is DROPPED — ` +
          "an image has no text form to fall back to";
    notes.push(`${image.label}: ${reason}`);
    sections.push(undeliveredImageSection(image, reason));
  }

  const text = (blocks.length === 0 ? sections : [imageRoster(blocks, labels), ...sections]).join("\n");
  return { blocks, labels, text, base64Chars, notes };
}

/**
 * The roster: which picture is which, in block order.
 *
 * THIS EXISTS BECAUSE `ImageBlockParam` HAS NO `title`. A document announces
 * itself on the wire; an image cannot, so without this the seat receives N
 * anonymous pictures and any sentence it writes about "the second reference" is
 * unanchored. The list is built from the blocks themselves so it cannot describe
 * an ordering the message does not have.
 *
 * IT ALSO STATES THE CITATION GAP OUT LOUD. The PDF path enables page-anchored
 * citations precisely so a criterion can name where it came from; there is no
 * such anchor for an image, and a seat that assumed otherwise would cite
 * something that cannot exist.
 */
function imageRoster(blocks: readonly SeatImageBlock[], labels: readonly string[]): string {
  const entries = blocks.map(
    (block, index) => `    ${String(index + 1)}. ${labels[index] ?? "(unnamed)"} (${block.source.media_type})`,
  );
  return [
    "",
    "--- REFERENCE IMAGES IN THIS MESSAGE ---",
    "",
    `The owner attached ${String(blocks.length)} reference image(s) and they ARE IN THIS MESSAGE, as`,
    "image blocks above this text. In the order they appear:",
    "",
    ...entries,
    "",
    "AN IMAGE BLOCK CARRIES NO FILENAME AND NO CITATION ANCHOR. This list is the only thing that says",
    "which picture is which, and there is no page number or quotable span you can cite back to one, so",
    "anything you say about a reference image is your own description of what you saw rather than a",
    "traceable quotation.",
    "",
    "--- END OF REFERENCE IMAGES ---",
    "",
  ].join("\n");
}

/**
 * An image that could not be carried, announced rather than omitted.
 *
 * DELIBERATELY PARALLEL TO {@link undeliveredSection} AND DELIBERATELY NOT THE
 * SAME FUNCTION. That one describes a document that could not be CARRIED and
 * whose extracted text was also missing — a coincidence of two failures. This
 * describes the ordinary case for an image, because there is no second channel:
 * "no extracted text was supplied for it either" would be a strange thing to say
 * about a PNG, and the instruction the seat needs is stronger.
 */
function undeliveredImageSection(image: SeatImage, reason: string): string {
  return [
    "",
    "--- ATTACHED REFERENCE IMAGE (NOT IN THIS PROMPT) ---",
    "",
    `The owner attached "${image.label}". IT IS NOT IN THIS MESSAGE.`,
    "",
    `Reason: ${reason}.`,
    "",
    "AN IMAGE HAS NO TEXT FORM, so unlike an attached document there is no extracted fallback: none of",
    "it is here in any shape. Do not describe it, do not guess what is in it, and do not write anything",
    "that depends on having seen it. If the work needs it, say plainly that a reference image was",
    "attached and could not be carried.",
    "",
    "--- END OF ATTACHED REFERENCE IMAGE ---",
    "",
  ].join("\n");
}

/**
 * What the run log should say about the pictures, in numbers this code measured.
 *
 * THE COUNTERPART TO {@link describeSeatDocuments} AND FOR THE SAME REASON: "the
 * seat asked a bad question" and "the seat never got the picture" are different
 * failures with different fixes, and after the run only a line like this can tell
 * them apart. So the branch where NOTHING travelled says so in those words rather
 * than reporting an attachment count and leaving the reader to infer.
 *
 * NO TOKEN FIGURE IS QUOTED. This file cannot convert pixels or bytes into input
 * tokens, and a plausible "≈ N tokens per image" would be a fabricated number in
 * a line the owner reads as measurement.
 */
export function describeSeatImages(plan: SeatImagePlan, calls: number): string {
  if (plan.notes.length === 0) return "no images were attached to this seat";
  const carried =
    plan.blocks.length === 0
      ? "NO IMAGE REACHED THE SEAT — every one of them was refused, and this seat saw no picture at all"
      : `${String(plan.blocks.length)} image block(s) in order (${plan.labels.join(", ")}), ` +
        `${String(plan.base64Chars)} base64 chars, re-sent on each of ${String(calls)} call(s) = ` +
        `${String(plan.base64Chars * calls)} base64 chars in total`;
  return `${String(plan.notes.length)} attached image(s): ${plan.notes.join("; ")} — ${carried}`;
}

/* -------------------------------------------------------------------------
 * From a file on disk to a SeatImage
 * ---------------------------------------------------------------------- */

/**
 * An image as the run's reference manifest records it: a path, and that is all.
 *
 * ONE FIELD, WHERE {@link AttachedDocument} HAS TWO, AND THAT IS THE MANIFEST'S
 * SHAPE RATHER THAN AN OMISSION. `ReferenceImage` is `{path, sha256, bytes}`
 * (ticket-refs.ts:127) — no media type is recorded for an image, unlike a
 * document — so the type is recovered from the intake-chosen extension by
 * {@link IMAGE_MEDIA_TYPES}. `ReferenceImage` satisfies this structurally, which
 * is the point: the orchestrator can pass the manifest's own rows.
 *
 * DELIBERATELY NOT `ReferenceImage` ITSELF, for the reason {@link AttachedDocument}
 * gives: this module has no business knowing what a manifest is.
 */
export interface AttachedImage {
  /**
   * Absolute host path. Used to READ the file and NEVER rendered into seat-facing
   * text: {@link seatImagesFor} carries the redacted basename instead.
   */
  readonly path: string;
}

/** Why an image's bytes did not become a block. Each has a different fix. */
export type SeatImageReadCode = "unreadable-file" | "empty" | "over-image-cap";

export type SeatImageRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly code: SeatImageReadCode; readonly detail: string };

export interface SeatImageOptions {
  /** Per-image DECODED byte cap. Defaults to {@link MAX_SEAT_IMAGE_BYTES}. */
  readonly maxImageBytes?: number;
  /** Injected so every refusal branch is reachable without a real file on disk. */
  readonly readBytes?: (path: string, maxBytes: number) => SeatImageRead;
}

/**
 * Read each attached image off disk and produce what the seat needs.
 *
 * SYNCHRONOUS, WHERE {@link seatDocumentsFor} IS ASYNC, and the difference is
 * real rather than stylistic: a document may have to spawn `pdftotext` or
 * `textutil`, and an image has nothing to extract — the bytes ARE the payload.
 * There is no capability to probe for the same reason, which is why this takes no
 * equivalent of `SeatDocumentOptions.capability`.
 *
 * NEVER THROWS ON A FILE. Every failure — missing, unreadable, zero bytes, over
 * the per-image cap, or an extension naming no acceptable media type — comes back
 * as a {@link SeatImage} with `block: null` and a named reason, never an
 * exception that would take down a spec phase over an attachment.
 *
 * NO HOST PATH REACHES THE SEAT, and for images that needs saying twice, because
 * the obvious implementation leaks one: `statSync`'s error message is
 * "ENOENT: no such file or directory, stat '/Users/.../runs/…'". The reason
 * strings below carry the error's `code` and never its message.
 */
export function seatImagesFor(
  attached: readonly AttachedImage[],
  options: SeatImageOptions = {},
): readonly SeatImage[] {
  const maxImageBytes = options.maxImageBytes ?? MAX_SEAT_IMAGE_BYTES;
  const readBytes = options.readBytes ?? readBoundedImage;

  const images: SeatImage[] = [];
  for (const image of attached) {
    const label = redactForPersistence(basename(image.path));
    const extension = extname(image.path).slice(1).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[extension];

    if (mediaType === undefined) {
      images.push({
        label,
        mediaType: null,
        block: null,
        declined:
          `its extension (${extension === "" ? "none" : `.${extension}`}) names no image media type this ` +
          `seat can carry — the API's base64 image source accepts ` +
          `${ACCEPTED_SEAT_IMAGE_MEDIA_TYPES.join(", ")} only — so it is dropped`,
      });
      continue;
    }

    const read = readBytes(image.path, maxImageBytes);
    if (!read.ok) {
      images.push({ label, mediaType, block: null, declined: read.detail });
      continue;
    }

    images.push({
      label,
      mediaType,
      block: {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: read.bytes.toString("base64") },
      },
      declined: null,
    });
  }
  return images;
}

/**
 * Read a whole image, but only if it is small enough to want — and say WHICH of
 * the three ways it was not.
 *
 * THE THREE ARE KEPT APART HERE WHERE `readBoundedFile` FLATTENS THEM TO `null`,
 * and the divergence is deliberate. For a document all three failures have the
 * same consequence (it travels as extracted text) so one reason serves. For an
 * image they have the same consequence — it does not travel — but three different
 * FIXES: a missing file is a wiring bug, a zero-byte file is a broken upload, and
 * an oversized one is the owner's to re-export smaller. Telling the owner "it
 * could not be read" when the file is simply 6 MB sends him to look for a bug
 * that is not there.
 *
 * THE SIZE IS CHECKED BEFORE THE READ, the same discipline `readBoundedFile`
 * states: `readFileSync` on a path this function did not choose is unbounded
 * memory, and past the cap the bytes are unwanted anyway.
 */
function readBoundedImage(path: string, maxBytes: number): SeatImageRead {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    return {
      ok: false,
      code: "unreadable-file",
      detail: `its bytes could not be read off disk (${fsErrorCode(error)}), so it is dropped`,
    };
  }
  if (size === 0) {
    return { ok: false, code: "empty", detail: "the file on disk is zero bytes long, so it is dropped" };
  }
  if (size > maxBytes) {
    return {
      ok: false,
      code: "over-image-cap",
      detail:
        `it is ${String(size)} bytes and this seat's per-image cap is ${String(maxBytes)} bytes, so it ` +
        "is dropped — an image has no text form to fall back to",
    };
  }
  try {
    return { ok: true, bytes: readFileSync(path) };
  } catch (error) {
    return {
      ok: false,
      code: "unreadable-file",
      detail: `its bytes could not be read off disk (${fsErrorCode(error)}), so it is dropped`,
    };
  }
}

/**
 * An fs error's `code` and NOTHING ELSE.
 *
 * `error.message` EMBEDS THE PATH — "ENOENT: no such file or directory, stat
 * '/Users/…/runs/run-…/references/reference-1.png'" — and these strings are
 * rendered into the prompt by {@link undeliveredImageSection}. Carrying the
 * message would put an absolute host path in front of the spec seat, which is
 * exactly what `ticket-refs.ts` forbids for the brief.
 */
function fsErrorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown error";
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
  /**
   * Reference images EVERY call this seat makes will carry. Absent means the
   * pre-image path, byte for byte — including for a seat that has documents.
   */
  readonly images?: readonly SeatImage[];
  /** Override {@link DEFAULT_SEAT_IMAGE_BASE64_CHARS}. */
  readonly imageBudgetBase64Chars?: number;
  /** The SDK's `query`, unless a test supplies a stream. */
  readonly startQuery?: SeatSessionFactory;
  /**
   * Where this seat reports that it is still alive, and roughly where it is.
   *
   * OPTIONAL, AND ABSENCE IS THE PRE-PROGRESS PATH BYTE FOR BYTE. Without it
   * `includePartialMessages` stays `false`, so the CLI never serialises a delta
   * frame and nothing crosses the pipe that did not cross it before — which is
   * what keeps the seats that have no consumer at their old cost. A stream of
   * `stream_event` frames for a 64,000-token response is 20,000-30,000 IPC
   * messages; paying for them where nobody reads them would be a regression
   * dressed as a feature.
   *
   * ONE SEAT IS STILL SILENT AND IT IS NAMED HERE RATHER THAN LEFT TO BE FOUND.
   * `judge.ts:282` builds its OWN `SubscriptionSeatCaller` for the code-reading
   * judge (32,000-token ceiling) and passes no `onProgress`, so that phase reports
   * nothing. The fix is this one option plus a sink from whoever owns that file;
   * `orchestrator.seat-progress.test.ts`'s wiring check counts the constructions
   * in `orchestrator.ts` only, and says so.
   */
  readonly onProgress?: SeatProgressSink;
  /**
   * Override {@link SEAT_PROGRESS_INTERVAL_MS}. A TEST SEAM, and the only way to
   * measure the bound without a 30-second test.
   */
  readonly progressIntervalMs?: number;
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
  readonly #imagePlan: SeatImagePlan;
  readonly #startQuery: SeatSessionFactory;
  readonly #onProgress: SeatProgressSink | null;
  readonly #progressIntervalMs: number;
  #tokens: TokenTotals = zeroTokens("anthropic");
  #rateLimit: RateLimitState = NOT_RATE_LIMITED;
  #calls = 0;
  #documentCalls = 0;
  #imageCalls = 0;

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
    // A SECOND PLAN, NOT A WIDER ONE. Folding images into `#plan` would change
    // what `documentPlan` and `documentCalls` mean for the callers already
    // reading them (orchestrator.ts:1994, 2114, 2135, 2143), so a run log line
    // that says "N attached document(s)" would start counting pictures.
    this.#imagePlan = planSeatImages(
      options.images ?? [],
      options.imageBudgetBase64Chars ?? DEFAULT_SEAT_IMAGE_BASE64_CHARS,
    );
    this.#startQuery = options.startQuery ?? query;
    this.#onProgress = options.onProgress ?? null;
    this.#progressIntervalMs = options.progressIntervalMs ?? SEAT_PROGRESS_INTERVAL_MS;
  }

  /**
   * Whether anything is listening for progress. EXPOSED so the wiring can be
   * asserted from outside: the orchestrator's seat construction is the branch
   * that spawns the real CLI, so a dropped `onProgress:` option is otherwise
   * only observable on the path no test can drive — the same hole
   * `#reportSeatImages` in `orchestrator.ts` documents for attached images.
   */
  get reportsProgress(): boolean {
    return this.#onProgress !== null;
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

  /** What every call carries in pictures, and why each image travels or does not. */
  get imagePlan(): SeatImagePlan {
    return this.#imagePlan;
  }

  /**
   * Calls DISPATCHED carrying at least one attached image — counted on the same
   * rule as {@link documentCalls}, and counted SEPARATELY from it so that a seat
   * with both does not report one dispatch as two.
   */
  get imageCalls(): number {
    return this.#imageCalls;
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
   *   - `maxOutputTokens` HAS NO SDK OPTION AND IS SENT ANYWAY, as
   *     `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in the subprocess environment (see
   *     {@link seatCallEnv}). This docblock previously said it was "enforced
   *     after the fact by the caller's own truncation check", which was an
   *     accurate description of a check that could never run: over-length came
   *     back as a THROWN error, so the truncation check downstream never saw a
   *     result to check. Both halves are fixed — the number now governs the
   *     call, and exceeding it now RETURNS with `stopReason: "max_tokens"`.
   *
   * THE OVER-LENGTH FAILURE IS THE ONE ERROR THIS METHOD DOES NOT THROW, and
   * that is the whole point of the classification below. Run
   * `run-2026-08-04T11-08-10-487Z-162b186d` spent 51 minutes in the spec phase
   * and died on "Claude's response exceeded the 64000 output token maximum",
   * three feet from a repair ladder in `spec-agent.ts` that detects exactly this,
   * raises the budget and retries for free. It never fired, because the ladder
   * reads a returned `SeatCallResult` and this method handed it an exception.
   * Every OTHER failure still throws with its remediation text intact.
   *
   * `tools: []` and `settingSources: []` are load-bearing. The spec seat must
   * be a structurally separate agent with no shared history and no access to
   * any implementation (doc 03 section 7.4); a spec seat that could read the
   * workspace, or that inherited the owner's CLAUDE.md, is not that agent.
   *
   * ATTACHED DOCUMENTS AND IMAGES RIDE ON EVERY CALL, INCLUDING REGENERATIONS.
   * Both plans are fixed at construction and {@link seatPrompt} rebuilds the
   * prompt per call, so authoring attempt 1 and authoring attempt 3 see the same
   * attachments. That is the point — a regeneration that lost them would author
   * its replacement suite from the ticket text alone while the log still said a
   * scope and three mockups were attached — and it is also the cost:
   * {@link DEFAULT_SEAT_NATIVE_BASE64_CHARS} and
   * {@link DEFAULT_SEAT_IMAGE_BASE64_CHARS} each name the multiplier, and neither
   * bounds the other.
   *
   * `options` IS UNTOUCHED BY EITHER. Only `prompt` changes shape; nothing about
   * a document or an image is expressible as an SDK option, and the
   * no-attachment path therefore passes the identical option object it always
   * did. IN PARTICULAR `tools: []` IS UNCHANGED — an image is CONTENT, not a
   * tool call, so carrying one does not and must not give this seat the ability
   * to open a file. That inability is a measured property the sealed-suite
   * boundary depends on, and it is why `plan-seat.ts` still forbids a criterion
   * that could only be graded by opening an attachment: the PLAN seat can see the
   * owner's pictures, and every seat downstream of it cannot.
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
      // ON ONLY WHEN SOMEONE IS LISTENING. This was hardcoded `false`, which is
      // why the spec phase was a 51-minute black box: a seat with `tools: []`
      // emits no tool call, and without partial messages the SDK yields exactly
      // two frames for a fifty-minute turn — the finished assistant message and
      // the result. See the progress section above for what the flag costs when
      // nobody reads it, which is why this is a condition and not a `true`.
      includePartialMessages: this.#onProgress !== null,
      env: seatCallEnv(this.#env, request.maxOutputTokens),
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
    // THE FOUR PLACES THE OVER-LENGTH FAILURE CAN SHOW ITSELF, all watched.
    // (3) and (4) below are the pair that was MEASURED on the run that died;
    // (1) and (2) are the ones the SDK's own types promise and which a future
    // CLI is more likely to keep than it is to keep the wording of a sentence.
    let overflowed = false;
    let overflowDetail = "";

    // BUILT PER CALL, NOT PER CALLER. An async generator is single-use; a
    // prompt built once and reused would deliver the document to the first
    // attempt and an empty message to every regeneration after it.
    const prompt = seatPrompt(request, this.#plan, this.#imagePlan);
    if (this.#plan.notes.length > 0) this.#documentCalls += 1;
    if (this.#imagePlan.notes.length > 0) this.#imageCalls += 1;

    // PER CALL, LIKE THE PROMPT, AND FOR THE SAME REASON. The elapsed clock and
    // the character total describe THIS dispatch; a coalescer held on the caller
    // would report authoring attempt 3 as though it had been running since
    // attempt 1 started.
    const progress =
      this.#onProgress === null
        ? null
        : new SeatProgressCoalescer(request.purpose, this.#onProgress, {
            intervalMs: this.#progressIntervalMs,
          });

    try {
      const session = this.#startQuery({ prompt, options });
      for await (const message of session) {
        if (message.type === "stream_event") {
          // THE DELTAS ARE NOT ACCUMULATED INTO `text`, DELIBERATELY. The SDK
          // yields the completed `assistant` frame AS WELL AS the partials, and
          // `text` is built from that frame alone — so turning progress on
          // cannot change one byte of what the parser downstream receives. The
          // coalescer holds its own copy and throws it away.
          //
          // "AS WELL AS" IS READ, NOT ASSUMED, AND IT IS READ STATICALLY. The SDK
          // turns the option into the CLI flag `--include-partial-messages`
          // (`sdk.mjs`: `if (Ft) H.push("--include-partial-messages")`), whose
          // name is additive; the CLI's own stream loop assembles and yields a
          // `type:"assistant"` message at each content-block boundary in the same
          // loop that yields `stream_event`, and the only thing that loop
          // `continue`s past is a ping. What was NOT done is a live call — the
          // fallback if that read is ever wrong is the result frame's
          // `if (text.length === 0) text = message.result` below, which already
          // covers a turn that produced no assistant frame. The one thing that
          // WOULD degrade is `isOutputOverflowFrame`, which only inspects
          // assistant frames; signals (3) and (4) — the pair actually measured on
          // the run that died — do not depend on it, so the ladder still fires.
          if (progress !== null) progress.push(partialAssistantText(message));
        } else if (message.type === "assistant") {
          text += assistantText(message);
          // (1) THE STRUCTURED SIGNAL. The CLI sets `error: "max_output_tokens"`
          // on the synthetic assistant frame it emits when the API stream stops
          // on max_tokens, and the SDK forwards that field verbatim. Preferred
          // over the prose, per the rule that a structured field beats English.
          if (isOutputOverflowFrame(message)) overflowed = true;
        } else if (message.type === "rate_limit_event") {
          this.#noteRateLimit(rateLimitFrom(message.rate_limit_info));
        } else if (message.type === "result") {
          stopReason = message.stop_reason;
          tokens = extractTokens(message.usage);
          thinkingTokens = readThinkingTokens(message.usage);
          // (2) THE RESULT FRAME'S OWN STOP REASON. `SDKResultError` declares
          // `stop_reason`, and the CLI's own diagnostic errors carry
          // `stop_reason=max_tokens` in them. Not observed on the measured
          // failure — which is why it is one signal of several, not the signal.
          if (stopReason === OVERFLOW_STOP_REASON) overflowed = true;
          if (message.subtype === "success") {
            structured = message.structured_output;
            if (text.length === 0) text = message.result;
            // (3) A "SUCCESS" SUBTYPE THAT IS NOT ONE. This is the shape the
            // measured run produced: subtype "success", `is_error` set, and the
            // CLI's complaint sitting in `result`. Read here rather than
            // trusted to reappear later, because the SDK re-throws it as a bare
            // Error with every structured field gone.
            if (message.is_error && isOutputOverflowText(message.result)) {
              overflowed = true;
              overflowDetail = message.result;
            }
          } else {
            failure = `${message.subtype}: ${resultErrorText(message)}`;
            if (isOutputOverflowText(failure)) {
              overflowed = true;
              overflowDetail = failure;
            }
          }
        }
      }
    } catch (error) {
      // (4) THE THROW, WHICH IS WHAT ACTUALLY HAPPENED. The SDK's reader
      // replaces the subprocess exit error with
      // `Error("Claude Code returned an error result: <text>")` and the stream
      // rejects. Everything but an over-length failure still leaves by
      // `#asCallError` with its remediation text unchanged; an over-length
      // failure falls through to the return below so that `spec-agent`'s
      // truncation ladder can act on it.
      const message = error instanceof Error ? error.message : String(error);
      if (!overflowed && !isOutputOverflowText(message)) {
        throw this.#asCallError(error, request.purpose);
      }
      overflowed = true;
      if (overflowDetail.length === 0) overflowDetail = message;
    }

    // ACCOUNTING BEFORE ANY RETURN, INCLUDING THE OVERFLOW ONE. A truncated
    // attempt still spent the tokens it emitted, and the ladder is about to make
    // a SECOND call: dropping the first would understate the run's own cost
    // figure by exactly the expensive half.
    this.#tokens = addTokens(this.#tokens, tokens);
    this.#calls += 1;

    // Prefer the schema-validated object when one was requested and returned.
    // spec-agent parses text, so a structured result is re-serialised rather
    // than handed over as an object — same parse path, one less special case.
    // HOISTED ABOVE THE OVERFLOW RETURN so both exits use one rule; a second
    // copy of this expression is a second place for the two to drift.
    const responseText = structured === undefined ? text : JSON.stringify(structured);

    if (overflowed) {
      return {
        // THE SAME TEXT RULE AS THE SUCCESS RETURN, PLUS ONE FALLBACK. The
        // structured-output preference is shared deliberately: a truncated turn
        // that nonetheless produced a partial object must reach the parser by the
        // route every other turn takes. When there is nothing at all, the CLI's
        // own diagnostic stands in — `spec-agent` reads `stopReason` before it
        // reads text so this changes nothing there, but `plan-seat.ts` logs `raw`
        // "for the run log when the parse refused" and a blank string would be
        // the only trace left of a turn that hit its ceiling.
        text: responseText.length > 0 ? responseText : redactText(overflowDetail).text,
        stopReason: OVERFLOW_STOP_REASON,
        usage: subscriptionUsage(this.seat as AnthropicSeat, tokens, thinkingTokens),
        pricingBasis: subscriptionPricingBasis(this.seat.modelId, startedAt),
        precall: decision,
        inputEstimateMeasured: false,
        startedAt,
        endedAt: new Date().toISOString(),
      };
    }

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
    if (rateLimited) {
      // THE RESET INSTANT, IF THE PROVIDER NAMED ONE — see
      // {@link parseRetryAfterSeconds}. This was hardcoded `null` until
      // 2026-08-09, which meant a refusal arriving as prose could never arm a
      // wait even when the sentence carrying it said exactly how long to wait:
      // `recovery.ts` stopped on `no_retry_after` and the run parked for a
      // human. `null` is still what a sentence with no number in it produces,
      // and `recovery.ts` now holds a bounded, labelled wait for that case
      // rather than parking — the number is not invented here.
      this.#noteRateLimit({
        limited: true,
        retryAfterSec: parseRetryAfterSeconds(message),
        // NOT GUESSED. Which window refused is not derivable from the sentence,
        // and `five_hour` vs `seven_day` is the difference between a wait this
        // server holds and one it refuses to hold unattended.
        kind: null,
        utilization: null,
      });
    }
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
