/**
 * redact.ts — the single chokepoint every byte passes through before it is
 * persisted to a result, a log or a report.
 *
 * Design follows doc 02 section 1.6, in order:
 *
 *   1. REASSEMBLE streamed output before matching. A regex applied per SSE
 *      delta will not match a key that spans two chunks. This module therefore
 *      exposes {@link ReassemblingRedactor} and deliberately exposes NO
 *      per-chunk function.
 *   2. EXACT-MATCH every canonical encoding of each KNOWN value: raw, base64
 *      (standard, url-safe, unpadded), percent-encoded, JSON \u-escaped.
 *      This is the reliable pass.
 *   3. ENTROPY / PATTERN SCAN as an independent second pass, for secrets that
 *      were never registered. Different job, different failure profile.
 *   4. Replace with a STABLE token, `[REDACTED:NAME]`, so a reader can still
 *      reason about which secret was involved without seeing any part of it.
 *
 * A partial is still a leak: nothing here emits a prefix, a suffix, a last-4 or
 * a length. Credential values are read from `process.env` inside this module
 * and are never returned, logged or stored.
 */

import { Buffer } from "node:buffer";
import { BakeoffError } from "./contracts.js";

/** All replacements begin with this, so redaction is idempotent and visible. */
export const REDACTION_PLACEHOLDER_PREFIX = "[REDACTED:";

/**
 * Bytes of tail held back by {@link ReassemblingRedactor} before flushing.
 *
 * INVARIANT: no rule in {@link CREDENTIAL_RULES} may match a span longer than
 * this. 16 KiB comfortably exceeds a PEM-armoured RSA-4096 private key block,
 * which is the longest span any rule here can match. Raising a rule's possible
 * span without raising this constant reintroduces the split-secret bug the
 * class exists to prevent.
 */
export const OVERLAP_WINDOW_CHARS = 16_384;

/** Hard cap on buffered text before a forced flush. */
export const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

/* -------------------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------------------- */

export interface RedactionRule {
  /** Appears inside the placeholder, e.g. `[REDACTED:ANTHROPIC_API_KEY_SHAPE]`. */
  readonly name: string;
  /** MUST be a global regex. */
  readonly pattern: RegExp;
  readonly description: string;
  /**
   * Optional veto. Return false to leave a match untouched. Used to stop
   * heuristic rules from destroying the harness's own records (environment
   * variable NAMES, content digests, status words).
   */
  readonly accept?: (match: RegExpExecArray) => boolean;
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/**
 * Field-name suffixes whose values are never credentials in this system:
 * variable names, content digests, paths, ids, and the descriptive fields that
 * carry the harness's own prose. `rule` is on the list because
 * `tokenAccountingRule` — held-constant variable 6 — contains "token" and its
 * value is a long kebab-case string that would otherwise be scrubbed out of
 * every run record.
 */
const DIGEST_LIKE_NAME_RE =
  /(?:name|names|sha256|digest|hash|checksum|fingerprint|path|paths|id|ids|count|status|source|label|tier|kind|type|version|rule|rules|policy|mode|role|roles|notes|detail|details|message|description|reason|remediation)$/i;
/** kebab- or snake-cased lowercase words: an enum value or prose, not a key. */
const WORDY_VALUE_RE = /^[a-z]+(?:[-_][a-z]+)+$/;
const NON_SECRET_WORD_RE =
  /^(?:changeme|change_me|placeholder|none|null|undefined|missing|present|absent|empty|unset|todo|example|redacted|true|false)$/i;

function looksLikeAPlaceholder(value: string): boolean {
  if (value.startsWith(REDACTION_PLACEHOLDER_PREFIX)) return true;
  if (NON_SECRET_WORD_RE.test(value)) return true;
  if (value.startsWith("<") && value.endsWith(">")) return true;
  if (/^your[-_ ]/i.test(value)) return true;
  return false;
}

/**
 * Credential-shaped patterns.
 *
 * Ordered most specific first, so a key that matches a vendor rule is labelled
 * with that vendor rather than by the generic high-entropy rule.
 */
export const CREDENTIAL_RULES: readonly RedactionRule[] = Object.freeze([
  {
    name: "PEM_PRIVATE_KEY",
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    description: "PEM-armoured private key block (e.g. an App Store Connect .p8).",
  },
  {
    name: "ANTHROPIC_KEY_SHAPE",
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{16,}/g,
    description: "Anthropic API key.",
  },
  {
    name: "SK_PREFIXED_KEY_SHAPE",
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
    description: "OpenAI / DeepSeek / Moonshot style sk- API key.",
  },
  {
    name: "STRIPE_KEY_SHAPE",
    pattern: /(?<![A-Za-z0-9_-])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
    description: "Stripe secret, restricted or publishable key.",
  },
  {
    name: "GITHUB_TOKEN_SHAPE",
    pattern: /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    description: "GitHub personal access / app / OAuth token.",
  },
  {
    name: "AWS_ACCESS_KEY_ID",
    pattern: /(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_-])/g,
    description: "AWS access key id.",
  },
  {
    name: "GOOGLE_API_KEY_SHAPE",
    pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
    description: "Google API key.",
  },
  {
    name: "SLACK_TOKEN_SHAPE",
    pattern: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}/g,
    description: "Slack token.",
  },
  {
    name: "JWT_SHAPE",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    description: "JSON Web Token (Supabase service keys take this shape).",
  },
  {
    name: "AUTHORIZATION_HEADER",
    pattern: /\b[Aa]uthorization\s*[:=]\s*(?:"|')?(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    description: "Authorization header carrying a bearer/basic credential.",
  },
  {
    name: "URL_USERINFO",
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]{4,})@/g,
    description: "Credential embedded in a URL's userinfo component.",
  },
  {
    name: "SECRET_ASSIGNMENT",
    // A name containing a secret-ish word, then = or :, then a long value.
    // The separator group deliberately allows a closing quote before the
    // punctuation so that JSON — `"apiKey": "value"` — matches. JSON is the
    // dominant shape of agent tool output and transcripts; a rule that only
    // matched shell-style KEY=value would miss almost everything this harness
    // actually persists.
    pattern:
      /(?<![A-Za-z0-9_-])([A-Za-z0-9_.-]{0,48}(?:api[_-]?key|key|token|secret|password|passwd|credential|bearer|authorization)[A-Za-z0-9_.-]{0,48})(["']?\s*[:=]\s*)(["']?)([^\s"',;)\]}]{16,})\3/gi,
    description:
      "KEY=value and \"token\": \"value\" assignments, shell and JSON forms. Heuristic: vetoed " +
      "for env-var NAMES, digest/id/name/rule-suffixed fields, kebab-cased enum values and " +
      "non-secret status words, so the harness's own records survive redaction intact.",
    accept: (match) => {
      const name = match[1] ?? "";
      const value = match[4] ?? "";
      if (DIGEST_LIKE_NAME_RE.test(name)) return false;
      if (ENV_NAME_RE.test(value)) return false; // the NAME of a variable, not a value
      if (looksLikeAPlaceholder(value)) return false;
      if (WORDY_VALUE_RE.test(value)) return false;
      // A run of plain words is prose, not a credential.
      if (/^[A-Za-z ]+$/.test(value) && value.length < 32) return false;
      return true;
    },
  },
  {
    name: "HIGH_ENTROPY_TOKEN",
    // 40+ chars of key-alphabet with lower AND upper AND digit present.
    pattern:
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
    description:
      "Independent entropy pass for unregistered secrets. Requires mixed case AND a digit, " +
      "which excludes lowercase-hex content digests, git SHAs and UUIDs — the harness's own " +
      "records are full of those and scrubbing them would destroy the freeze audit trail.",
  },
]);

/* -------------------------------------------------------------------------
 * Results
 * ---------------------------------------------------------------------- */

export interface RedactionFinding {
  /** Rule name, or the environment variable name for a known-value match. */
  readonly rule: string;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly findings: readonly RedactionFinding[];
  readonly redacted: boolean;
}

export interface RedactOptions {
  /**
   * Environment variable NAMES whose values are matched exactly, in every
   * canonical encoding. This is the reliable pass; the pattern rules are the
   * safety net. Defaults to {@link DEFAULT_KNOWN_ENV_NAMES}.
   */
  readonly knownEnvNames?: readonly string[];
  /** Source of values for the known-value pass. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Run the generic high-entropy rule. Default true. */
  readonly entropyScan?: boolean;
  /** Decode base64 / percent-encoded spans and re-test them. Default true. */
  readonly scanEncodedForms?: boolean;
}

/** Provider credential variables this harness knows about. */
export const DEFAULT_KNOWN_ENV_NAMES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
]);

function tally(map: Map<string, number>, rule: string, n: number): void {
  if (n <= 0) return;
  map.set(rule, (map.get(rule) ?? 0) + n);
}

function toFindings(map: Map<string, number>): readonly RedactionFinding[] {
  return [...map.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/* -------------------------------------------------------------------------
 * Known-value encodings
 * ---------------------------------------------------------------------- */

function unicodeEscaped(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

/**
 * Canonical encodings of one secret value, longest first.
 *
 * Covers raw, base64 (standard, unpadded, url-safe), percent-encoding (both
 * `encodeURIComponent` and `encodeURI`), JSON string escaping and full \u
 * escaping. Shell single-quoting is not enumerated because the quoted body is
 * byte-identical to the raw form and is therefore already covered.
 *
 * `base64(user:password)` for HTTP Basic cannot be enumerated without knowing
 * the username; the AUTHORIZATION_HEADER rule covers that shape instead.
 *
 * The returned strings ARE the secret in other encodings. Never log them.
 */
export function knownValueEncodings(value: string): readonly string[] {
  const buf = Buffer.from(value, "utf8");
  const b64 = buf.toString("base64");
  const candidates = new Set<string>([
    value,
    b64,
    b64.replace(/=+$/, ""),
    buf.toString("base64url"),
    encodeURIComponent(value),
    encodeURI(value),
    JSON.stringify(value).slice(1, -1),
    unicodeEscaped(value),
  ]);
  return [...candidates]
    .filter((c) => c.length >= 8)
    .sort((a, b) => b.length - a.length);
}

function isUsableSecret(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed.length < 8) return false;
  if (looksLikeAPlaceholder(trimmed)) return false;
  return true;
}

/**
 * Exact-match pass. Replaces every canonical encoding of the value held in each
 * named environment variable with `[REDACTED:<NAME>]`.
 *
 * Reads values internally; never returns or logs one.
 */
export function redactKnownEnvValues(
  text: string,
  names: readonly string[] = DEFAULT_KNOWN_ENV_NAMES,
  env: NodeJS.ProcessEnv = process.env,
): RedactionResult {
  let out = text;
  const counts = new Map<string, number>();

  for (const name of names) {
    const value = env[name];
    if (!isUsableSecret(value)) continue;
    const placeholder = `${REDACTION_PLACEHOLDER_PREFIX}${name}]`;
    for (const encoding of knownValueEncodings(value.trim())) {
      if (!out.includes(encoding)) continue;
      const parts = out.split(encoding);
      tally(counts, name, parts.length - 1);
      out = parts.join(placeholder);
    }
  }

  return { text: out, findings: toFindings(counts), redacted: counts.size > 0 };
}

/* -------------------------------------------------------------------------
 * Pattern pass
 * ---------------------------------------------------------------------- */

function applyRules(
  text: string,
  rules: readonly RedactionRule[],
  counts: Map<string, number>,
): string {
  let out = text;
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    out = out.replace(pattern, (...args: unknown[]) => {
      const groups = args.slice(0, -2) as string[];
      const whole = groups[0] ?? "";
      if (rule.accept !== undefined) {
        const asExec = groups as unknown as RegExpExecArray;
        if (!rule.accept(asExec)) return whole;
      }
      tally(counts, rule.name, 1);
      // Keep the field name and the surrounding quotes for SECRET_ASSIGNMENT:
      // a reader can still tell which variable was involved, and redacted JSON
      // stays parseable, which matters because these logs are re-read by tools.
      if (rule.name === "SECRET_ASSIGNMENT") {
        const fieldName = groups[1] ?? "";
        const separator = groups[2] ?? "=";
        const quote = groups[3] ?? "";
        return `${fieldName}${separator}${quote}${REDACTION_PLACEHOLDER_PREFIX}${rule.name}]${quote}`;
      }
      return `${REDACTION_PLACEHOLDER_PREFIX}${rule.name}]`;
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Encoded-form pass
 * ---------------------------------------------------------------------- */

const BASE64_CANDIDATE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/=_-])/g;
const PERCENT_CANDIDATE = /(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2}){12,}/g;

function anyRuleMatches(text: string, rules: readonly RedactionRule[]): boolean {
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      if (rule.accept === undefined || rule.accept(match)) return true;
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }
  return false;
}

function decodeBase64(candidate: string): string | null {
  try {
    const decoded = Buffer.from(candidate, "base64").toString("utf8");
    if (decoded.length < 8) return null;
    // Reject binary noise: a re-encoded secret decodes to printable text.
    const printable = decoded.replace(/[^\x20-\x7e]/g, "").length;
    if (printable / decoded.length < 0.9) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Second pass over base64 and percent-encoded spans: decode, re-test the
 * credential rules, and if a rule fires, redact the ENCODED span in the
 * original text. Prevents an agent that base64s a key into a log from
 * defeating the pattern rules.
 */
function redactEncodedForms(
  text: string,
  rules: readonly RedactionRule[],
  counts: Map<string, number>,
): string {
  let out = text.replace(BASE64_CANDIDATE, (candidate) => {
    if (candidate.startsWith(REDACTION_PLACEHOLDER_PREFIX)) return candidate;
    const decoded = decodeBase64(candidate);
    if (decoded === null || !anyRuleMatches(decoded, rules)) return candidate;
    tally(counts, "BASE64_ENCODED_SECRET", 1);
    return `${REDACTION_PLACEHOLDER_PREFIX}BASE64_ENCODED_SECRET]`;
  });

  out = out.replace(PERCENT_CANDIDATE, (candidate) => {
    if (!candidate.includes("%")) return candidate;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return candidate;
    }
    if (decoded === candidate || !anyRuleMatches(decoded, rules)) return candidate;
    tally(counts, "PERCENT_ENCODED_SECRET", 1);
    return `${REDACTION_PLACEHOLDER_PREFIX}PERCENT_ENCODED_SECRET]`;
  });

  return out;
}

/* -------------------------------------------------------------------------
 * The public chokepoint
 * ---------------------------------------------------------------------- */

function activeRules(options: RedactOptions): readonly RedactionRule[] {
  const entropyScan = options.entropyScan ?? true;
  return entropyScan
    ? CREDENTIAL_RULES
    : CREDENTIAL_RULES.filter((r) => r.name !== "HIGH_ENTROPY_TOKEN");
}

/**
 * Redact one COMPLETE piece of text.
 *
 * Must be given reassembled text. For streamed output use
 * {@link ReassemblingRedactor}.
 */
export function redactText(text: string, options: RedactOptions = {}): RedactionResult {
  const counts = new Map<string, number>();
  const rules = activeRules(options);

  const known = redactKnownEnvValues(
    text,
    options.knownEnvNames ?? DEFAULT_KNOWN_ENV_NAMES,
    options.env ?? process.env,
  );
  for (const f of known.findings) tally(counts, f.rule, f.count);

  let out = applyRules(known.text, rules, counts);
  if (options.scanEncodedForms ?? true) {
    out = redactEncodedForms(out, rules, counts);
  }

  return { text: out, findings: toFindings(counts), redacted: counts.size > 0 };
}

/** Object keys whose string values are content digests, not secrets. */
const DIGEST_SAFE_KEY_RE = /^(?:sha256|commit)$|(?:sha256|digest|hash|checksum|fingerprint)$/i;

/** True when a key holds a content digest that must survive redaction. */
export function isDigestSafeKey(key: string): boolean {
  return DIGEST_SAFE_KEY_RE.test(key);
}

/**
 * Redact every string inside a structure, preserving its shape.
 *
 * Keys are NOT redacted (they are field names; never use a secret as a key).
 * Values under digest-safe keys are left intact so the freeze audit trail —
 * `sha256`, `scorerImageDigest`, `commit` — survives: without this, the entropy
 * rule would eventually scrub the very hashes that prove the suite was frozen.
 */
export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
  return walk(value, options, false) as T;
}

function walk(value: unknown, options: RedactOptions, digestSafe: boolean): unknown {
  if (typeof value === "string") {
    return digestSafe ? value : redactText(value, options).text;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, options, digestSafe));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      out[key] = walk(source[key], options, isDigestSafeKey(key));
    }
    return out;
  }
  return value;
}

/**
 * THE chokepoint. Everything written to results, logs or reports goes through
 * here — including anything a judge or auditor will later read, because a
 * grader reading an un-redacted trace is itself a context leak
 * (doc 02 section 5.2).
 */
export function redactForPersistence<T>(value: T, options: RedactOptions = {}): T {
  if (typeof value === "string") {
    return redactText(value, options).text as unknown as T;
  }
  return redactDeep(value, options);
}

/**
 * Self-check: throws if any credential pattern still matches. Use it in tests
 * and at the boundary where redacted text is handed to a persistence layer.
 */
export function assertRedacted(text: string, options: RedactOptions = {}): void {
  const rules = activeRules(options);
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      if (rule.accept === undefined || rule.accept(match)) {
        throw new BakeoffError(
          "invalid_usage_shape",
          `un-redacted content matches rule ${rule.name}`,
          "Route this text through redactForPersistence() before persisting it. " +
            "The offending value is deliberately not included in this message.",
        );
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }
}

/* -------------------------------------------------------------------------
 * Streaming
 * ---------------------------------------------------------------------- */

interface Range {
  readonly start: number;
  readonly end: number;
}

function matchRanges(
  text: string,
  rules: readonly RedactionRule[],
  knownNames: readonly string[],
  env: NodeJS.ProcessEnv,
): readonly Range[] {
  const ranges: Range[] = [];

  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      if (rule.accept === undefined || rule.accept(match)) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }

  for (const name of knownNames) {
    const value = env[name];
    if (!isUsableSecret(value)) continue;
    for (const encoding of knownValueEncodings(value.trim())) {
      let from = text.indexOf(encoding);
      while (from !== -1) {
        ranges.push({ start: from, end: from + encoding.length });
        from = text.indexOf(encoding, from + 1);
      }
    }
  }

  return ranges;
}

/**
 * Streaming-safe redactor.
 *
 * A regex applied per chunk cannot match a secret split across two chunks, so
 * this class NEVER matches a chunk. It buffers, and only ever emits a prefix
 * that (a) is at least {@link OVERLAP_WINDOW_CHARS} away from the end of what
 * it has seen, and (b) does not cut through any candidate match. A secret whose
 * first byte lands before the cut point therefore always has its whole body
 * buffered before the cut is taken.
 *
 * Usage:
 *   const r = new ReassemblingRedactor();
 *   for await (const chunk of stream) out.write(r.write(chunk));
 *   out.write(r.finish());
 */
export class ReassemblingRedactor {
  #buffer = "";
  #options: RedactOptions;
  #counts = new Map<string, number>();
  #forcedFlushes = 0;

  constructor(options: RedactOptions = {}) {
    this.#options = options;
  }

  /** Feed a chunk. Returns whatever is now safe to emit (often ""). */
  write(chunk: string): string {
    this.#buffer += chunk;

    if (this.#buffer.length > MAX_BUFFER_CHARS) {
      // A pathological stream with no safe cut point. Flush what we have,
      // redacted, rather than growing without bound. Recorded so the run can
      // be treated as suspect.
      this.#forcedFlushes += 1;
      const forced = this.#buffer;
      this.#buffer = "";
      return this.#redact(forced);
    }

    if (this.#buffer.length <= OVERLAP_WINDOW_CHARS) return "";

    const desiredCut = this.#buffer.length - OVERLAP_WINDOW_CHARS;
    const rules = activeRules(this.#options);
    const ranges = matchRanges(
      this.#buffer,
      rules,
      this.#options.knownEnvNames ?? DEFAULT_KNOWN_ENV_NAMES,
      this.#options.env ?? process.env,
    );

    let safeCut = desiredCut;
    for (const range of ranges) {
      if (range.end > desiredCut && range.start < safeCut) safeCut = range.start;
    }
    if (safeCut <= 0) return "";

    const head = this.#buffer.slice(0, safeCut);
    this.#buffer = this.#buffer.slice(safeCut);
    return this.#redact(head);
  }

  /** Flush the retained tail. Re-runs redaction over it. */
  finish(): string {
    const tail = this.#buffer;
    this.#buffer = "";
    return this.#redact(tail);
  }

  /** Everything redacted so far, for the run log's redaction summary. */
  findings(): readonly RedactionFinding[] {
    return toFindings(this.#counts);
  }

  /**
   * Number of times the buffer cap forced a flush with no safe cut point.
   * Non-zero means the stream contained a >4 MiB span with no safe boundary;
   * treat the run's logs as suspect and investigate.
   */
  forcedFlushes(): number {
    return this.#forcedFlushes;
  }

  #redact(text: string): string {
    if (text.length === 0) return "";
    const result = redactText(text, this.#options);
    for (const f of result.findings) tally(this.#counts, f.rule, f.count);
    return result.text;
  }
}
