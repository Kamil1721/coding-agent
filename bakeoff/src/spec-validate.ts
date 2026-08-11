/**
 * spec-validate.ts — the deterministic half of the bad-test audit.
 *
 * doc 03 section 5 ranks bad-test detection as the number one quality lever in
 * the whole packet (+26.3pp, TDFlow). doc 02 section 5.3 explains why half of
 * that detector must not be an LLM: deterministic gates are "cheap, fast, and
 * structurally immune to every judge bias in the literature. These are the only
 * genuinely independent votes you have."
 *
 * So the audit is two passes with different failure profiles:
 *
 *   1. THIS MODULE — literal, structural, mechanical. No model, no judgement,
 *      no cost. Runs first and always.
 *   2. spec-agent.ts's adversarial judge pass — vacuity, mis-specification,
 *      ambiguity, implementation leakage. Needs judgement, costs money.
 *
 * SEVERITY IS DELIBERATE, NOT UNIFORM. `mustRegenerate: true` throws the whole
 * suite away and spends another Opus 5 `xhigh` authoring call. A false positive
 * in a heuristic therefore costs real money and can exhaust the attempt cap,
 * leaving a ticket with NO suite at all. So:
 *
 *   - LITERAL checks (an exact substring, a malformed id, a path that does not
 *     parse, a syntax error `node --check` reports) are BLOCKING. They cannot
 *     be wrong about what they saw.
 *   - HEURISTIC checks ("this test body looks assertion-free", "these two
 *     fixtures look similar") are ADVISORY. They are recorded on the suite and
 *     shown in the audit report, and they never trigger a regeneration.
 *
 * Nothing in this module writes a file into the sealed suite tree, and nothing
 * routes a test file's bytes through the redactor: the frozen bytes and the
 * frozen digest must stay identical, and `redactForPersistence` would silently
 * rewrite a plausible fixture. Redaction is used here in DETECTION mode only.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditFinding, AuditFindingKind, CriterionTier, Ticket } from "./contracts.js";
import { redactText } from "./redact.js";
// The scorer's own manifest parser, used as the authoring-time validator. One
// definition of the manifest shape, checked in both places, so a suite cannot
// be frozen in a form the sealed container will later refuse.
import { SUITE_ENV_NAMES, collectManifestProblems } from "./scorer-protocol.js";
import type { ManifestProblem } from "./scorer-protocol.js";
import {
  MAX_CRITERIA,
  MIN_VISIBLE_FUNCTIONAL_FRACTION,
  REQ_ID_PATTERN,
  RUNNER_SUFFIX,
  SUITE_VISIBILITIES,
  TEST_ID_PATTERN,
  isSuiteManifestPath,
  pathProblems,
  runnerOfPath,
  visibilityOfPath,
} from "./spec-types.js";
import type {
  DraftCriterion,
  DraftTestFile,
  SuiteDraft,
  SuiteVisibility,
  TestRunner,
} from "./spec-types.js";

/* -------------------------------------------------------------------------
 * 1. Findings
 * ---------------------------------------------------------------------- */

function blocking(kind: AuditFindingKind, criterionId: string | null, detail: string): AuditFinding {
  return { criterionId, kind, detail, mustRegenerate: true };
}

function advisory(kind: AuditFindingKind, criterionId: string | null, detail: string): AuditFinding {
  return { criterionId, kind, detail, mustRegenerate: false };
}

/** Every finding detail is redacted: a finding quotes suite source verbatim. */
function safe(text: string): string {
  return redactText(text).text;
}

/* -------------------------------------------------------------------------
 * 2. Parsing the spec seat's response into a draft
 * ---------------------------------------------------------------------- */

export type ParseResult =
  | { readonly ok: true; readonly draft: SuiteDraft }
  | { readonly ok: false; readonly problems: readonly string[] };

const TIERS: readonly CriterionTier[] = ["BLOCKING", "FUNCTIONAL", "QUALITY"];

function asRecord(value: unknown, where: string, problems: string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${where}: expected an object`);
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string, problems: string[]): string | null {
  if (typeof value !== "string") {
    problems.push(`${where}: expected a string`);
    return null;
  }
  return value;
}

function asStringArray(value: unknown, where: string, problems: string[]): readonly string[] | null {
  if (!Array.isArray(value)) {
    problems.push(`${where}: expected an array of strings`);
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (typeof item !== "string") {
      problems.push(`${where}[${i}]: expected a string`);
      return null;
    }
    out.push(item);
  }
  return out;
}

function asTier(value: unknown, where: string, problems: string[]): CriterionTier | null {
  if (typeof value !== "string" || !TIERS.includes(value as CriterionTier)) {
    problems.push(`${where}: expected one of ${TIERS.join(" | ")}`);
    return null;
  }
  return value as CriterionTier;
}

function asVisibility(value: unknown, where: string, problems: string[]): SuiteVisibility | null {
  if (typeof value !== "string" || !SUITE_VISIBILITIES.includes(value as SuiteVisibility)) {
    problems.push(`${where}: expected one of ${SUITE_VISIBILITIES.join(" | ")}`);
    return null;
  }
  return value as SuiteVisibility;
}

function asRunner(value: unknown, where: string, problems: string[]): TestRunner | null {
  if (value !== "node-test" && value !== "playwright") {
    problems.push(`${where}: expected "node-test" or "playwright"`);
    return null;
  }
  return value;
}

/**
 * Turn the spec seat's JSON into a {@link SuiteDraft}.
 *
 * Returns problems rather than throwing: a malformed model response is an
 * EXPECTED outcome that the authoring loop handles by regenerating, not an
 * exceptional condition. Problems are phrased so they can be fed straight back
 * into the regeneration prompt.
 */
export function parseSuiteDraft(raw: unknown, ticket: Ticket): ParseResult {
  const problems: string[] = [];
  const root = asRecord(raw, "response", problems);
  if (root === null) return { ok: false, problems };

  const rawCriteria: unknown = root["criteria"];
  const rawFiles: unknown = root["testFiles"];
  if (!Array.isArray(rawCriteria)) problems.push('response.criteria: expected an array');
  if (!Array.isArray(rawFiles)) problems.push('response.testFiles: expected an array');
  if (problems.length > 0) return { ok: false, problems };

  const criteria: DraftCriterion[] = [];
  for (let i = 0; i < (rawCriteria as unknown[]).length; i += 1) {
    const where = `response.criteria[${i}]`;
    const item = asRecord((rawCriteria as unknown[])[i], where, problems);
    if (item === null) continue;
    const id = asString(item["id"], `${where}.id`, problems);
    const statement = asString(item["statement"], `${where}.statement`, problems);
    const evidenceRequired = asString(item["evidenceRequired"], `${where}.evidenceRequired`, problems);
    const tier = asTier(item["tier"], `${where}.tier`, problems);
    const holdoutTestIds = asStringArray(item["holdoutTestIds"], `${where}.holdoutTestIds`, problems);
    const visibleTestIds = asStringArray(item["visibleTestIds"], `${where}.visibleTestIds`, problems);
    const evidenceArtifacts = asStringArray(
      item["evidenceArtifacts"] ?? [],
      `${where}.evidenceArtifacts`,
      problems,
    );
    if (
      id === null ||
      statement === null ||
      evidenceRequired === null ||
      tier === null ||
      holdoutTestIds === null ||
      visibleTestIds === null ||
      evidenceArtifacts === null
    ) {
      continue;
    }
    criteria.push({ id, statement, evidenceRequired, tier, holdoutTestIds, visibleTestIds, evidenceArtifacts });
  }

  const files: DraftTestFile[] = [];
  for (let i = 0; i < (rawFiles as unknown[]).length; i += 1) {
    const where = `response.testFiles[${i}]`;
    const item = asRecord((rawFiles as unknown[])[i], where, problems);
    if (item === null) continue;
    const path = asString(item["path"], `${where}.path`, problems);
    const visibility = asVisibility(item["visibility"], `${where}.visibility`, problems);
    const runner = asRunner(item["runner"], `${where}.runner`, problems);
    const description = asString(item["description"] ?? "", `${where}.description`, problems);
    const expectedTestIds = asStringArray(item["testIds"], `${where}.testIds`, problems);
    const criterionIds = asStringArray(item["criterionIds"], `${where}.criterionIds`, problems);
    const source = asString(item["source"], `${where}.source`, problems);
    if (
      path === null ||
      visibility === null ||
      runner === null ||
      description === null ||
      expectedTestIds === null ||
      criterionIds === null ||
      source === null
    ) {
      continue;
    }
    files.push({ path, visibility, runner, description, expectedTestIds, criterionIds, source });
  }

  if (problems.length > 0) return { ok: false, problems };
  if (criteria.length === 0) return { ok: false, problems: ["response.criteria is empty"] };
  if (files.length === 0) return { ok: false, problems: ["response.testFiles is empty"] };

  return {
    ok: true,
    draft: { ticketId: ticket.id, ticketSha256: ticket.sha256, criteria, files },
  };
}

/* -------------------------------------------------------------------------
 * 3. EARS notation
 * ---------------------------------------------------------------------- */

/**
 * EARS templates (Easy Approach to Requirements Syntax). One of:
 *   ubiquitous     "The <system> shall <response>"
 *   event-driven   "When <trigger>, the <system> shall <response>"
 *   state-driven   "While <state>, the <system> shall <response>"
 *   unwanted       "If <condition>, then the <system> shall <response>"
 *   optional       "Where <feature>, the <system> shall <response>"
 * Complex requirements chain the prefixes ("While X, when Y, the Z shall W")
 * and are matched by the leading keyword.
 */
/**
 * The determiners a ubiquitous statement may open with.
 *
 * WHY THIS IS NOT JUST `The`, AND WHAT IT COST TO LEARN. Run `aa6e721e` died on
 * `[mis_specified] REQ-013: statement matches no EARS template` for the statement
 * *"Each project page shall present …"*. That requirement is unambiguous, binary
 * and perfectly gradeable. It was refused for one word.
 *
 * The prompt shows the templates as `The <system> shall <response>`, and a writer
 * reasonably reads `<system>` as the slot and `The` as part of it — so
 * "Each project page" is a legal substitution to the author and a regex refusal
 * to the checker. Three attempts, roughly two hours, no build.
 *
 * Widening the determiner set loses nothing the grader needs: EARS constrains the
 * SHAPE of a requirement so it is testable, and "Each project page shall X" is the
 * same shape as "The project page shall X". Atomicity — one obligation per
 * criterion — is a separate concern (ISO/IEC/IEEE 29148's "singular"), is not part
 * of EARS at all, and is not enforced here either way.
 *
 * This is the checker being generous where strictness bought nothing. It is NOT a
 * licence to accept vagueness: the `shall` clause, the comma before it in the four
 * prefixed forms, and the ban on weak modals are all unchanged.
 */
const UBIQUITOUS_DETERMINERS = "(?:The|Each|Every|All|Any|A|An)";

const EARS_TEMPLATES: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: "ubiquitous", pattern: new RegExp(`^${UBIQUITOUS_DETERMINERS}\\s+\\S+[\\s\\S]*\\sshall\\s+\\S`) },
  { name: "event-driven", pattern: /^When\s+[\s\S]+,\s*[\s\S]*\sshall\s+\S/ },
  { name: "state-driven", pattern: /^While\s+[\s\S]+,\s*[\s\S]*\sshall\s+\S/ },
  { name: "unwanted-behaviour", pattern: /^If\s+[\s\S]+,\s*then\s+[\s\S]*\sshall\s+\S/ },
  { name: "optional-feature", pattern: /^Where\s+[\s\S]+,\s*[\s\S]*\sshall\s+\S/ },
]);

/**
 * Unambiguous 1-5 / 1-10 scale language.
 *
 * doc 02 section 5.4: "Binary criteria only. A calibrated 5-criterion 1-5
 * rubric measured a minimal, non-significant effect (-1.0 to +2.2 pp) with
 * Cohen's kappa unchanged. Scales are not actionable - nobody knows what to do
 * with a 3."
 *
 * Deliberately narrow. "the Lighthouse accessibility score shall be at least
 * 90" is a THRESHOLD, which is binary, and must not be flagged.
 */
const SCALE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bon\s+a\s+scale\b/i,
  /\brate[ds]?\s+(?:it\s+)?from\s+\d/i,
  /\b[1-9]\s*(?:-|–|—|\bto\b)\s*(?:5|10)\s+(?:scale|rating|rubric)/i,
  /\bout\s+of\s+(?:5|10)\b/i,
  /\b\d\s*\/\s*(?:5|10)\b/,
  /\b(?:five|ten)[- ]point\s+scale\b/i,
]);

/** Weak modals. EARS uses "shall"; "should"/"may" make a criterion unfalsifiable. */
const WEAK_MODAL_PATTERN = /\b(?:should|may|might|could|ideally|preferably)\b/i;

export interface StatementProblem {
  readonly blocking: boolean;
  readonly kind: AuditFindingKind;
  readonly detail: string;
}

/** Structural problems with one criterion statement. */
export function statementProblems(statement: string): readonly StatementProblem[] {
  const out: StatementProblem[] = [];
  const trimmed = statement.trim();

  if (trimmed.length === 0) {
    return [{ blocking: true, kind: "mis_specified", detail: "statement is empty" }];
  }
  if (!/\sshall\s/.test(trimmed)) {
    out.push({
      blocking: true,
      kind: "mis_specified",
      detail: 'statement is not EARS notation: it contains no "shall" clause',
    });
  }
  if (!EARS_TEMPLATES.some((t) => t.pattern.test(trimmed))) {
    out.push({
      blocking: true,
      kind: "mis_specified",
      detail:
        "statement matches no EARS template. Use one of: " +
        '"The <system> shall <response>" / "When <trigger>, the <system> shall <response>" / ' +
        '"While <state>, ... shall ..." / "If <condition>, then ... shall ..." / ' +
        '"Where <feature>, ... shall ..."',
    });
  }
  for (const pattern of SCALE_PATTERNS) {
    if (pattern.test(trimmed)) {
      out.push({
        blocking: true,
        kind: "mis_specified",
        detail:
          "statement uses a numeric scale. Criteria are BINARY only: a criterion either passed or " +
          "it did not. Rewrite as a threshold or a pass/fail condition.",
      });
      break;
    }
  }
  if (WEAK_MODAL_PATTERN.test(trimmed)) {
    out.push({
      blocking: false,
      kind: "ambiguous",
      detail: 'statement contains a weak modal (should/may/might/could/ideally). EARS uses "shall".',
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
 * 4. Literal source patterns
 * ---------------------------------------------------------------------- */

interface SourcePattern {
  readonly kind: AuditFindingKind;
  readonly pattern: RegExp;
  readonly detail: string;
}

/**
 * Patterns whose presence is a fact, not a judgement. All BLOCKING.
 *
 * The skip/only family and the `process.exit` family come straight out of
 * doc 02 section 5.6's observed-exploit table: `sys.exit(0)` before assertions
 * execute was measured in Anthropic production RL, and deleting or skipping
 * failing tests was measured by ImpossibleBench. They are listed here as suite
 * defects rather than builder defects because a suite that ships them cannot
 * detect them later.
 */
const BLOCKING_SOURCE_PATTERNS: readonly SourcePattern[] = Object.freeze([
  {
    kind: "vacuous",
    pattern: /\b(?:test|it|describe|suite)\s*\.\s*(?:skip|todo)\s*\(/,
    detail: "contains a skipped or todo test. A skipped test can never fail, so it gates nothing.",
  },
  {
    kind: "vacuous",
    pattern: /\b(?:xit|xdescribe|xtest)\s*\(/,
    detail: "contains an x-prefixed (disabled) test.",
  },
  {
    kind: "vacuous",
    pattern: /\b(?:test|it|describe)\s*\.\s*only\s*\(/,
    detail:
      "contains a .only() focus. Under a focus, every other test in the file silently does not run, " +
      "which turns most of the suite into decoration without failing anything.",
  },
  {
    kind: "tautological",
    pattern: /\bassert(?:\.(?:ok|strictEqual|equal|deepStrictEqual|deepEqual))?\s*\(\s*true\s*[,)]/,
    detail: "contains assert(true) / assert.ok(true), which cannot fail.",
  },
  {
    kind: "tautological",
    pattern: /\bassert\s*\.\s*(?:strict)?[eE]qual\s*\(\s*(-?\d+(?:\.\d+)?|true|false|null)\s*,\s*\1\s*\)/,
    detail: "asserts a literal equals itself.",
  },
  {
    kind: "tautological",
    pattern:
      /\bexpect\s*\(\s*(true|false|-?\d+(?:\.\d+)?)\s*\)\s*\.\s*(?:to)?(?:Be|Equal|toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
    detail: "asserts a literal equals itself.",
  },
  {
    kind: "trivially_satisfiable",
    pattern: /\bprocess\s*\.\s*(?:exit|abort|_exit)\s*\(/,
    detail:
      "calls process.exit()/abort() inside a test file. This is the sys.exit(0)-before-assertions " +
      "exploit that Anthropic measured in production RL: the process terminates green before the " +
      "assertions run.",
  },
  {
    kind: "other",
    pattern: /\b(?:TODO|FIXME|XXX)\b/,
    detail: "contains a TODO/FIXME/XXX marker. A frozen acceptance suite is finished or it is not sealed.",
  },
  {
    kind: "vacuous",
    pattern: /\bnot[ _-]?implemented\b/i,
    detail: 'contains a "not implemented" marker.',
  },
  {
    kind: "other",
    // fetch/goto/request to a non-loopback absolute URL. The suite executes in
    // a container with egress denied (config.ts SEALED_NETWORK_POLICY), so this
    // test cannot pass in ANY configuration.
    pattern:
      /\b(?:fetch|goto|navigate|request(?:\s*\.\s*\w+)?|axios(?:\s*\.\s*\w+)?|got|open)\s*\(\s*[`'"]https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/i,
    detail:
      "makes a network request to a non-loopback host. The sealed scorer container has egress " +
      "denied (held-constant variable 3), so this test fails identically in every configuration " +
      "and measures the network policy rather than the build.",
  },
]);

/** Heuristic patterns. ADVISORY: reported, never a regeneration trigger. */
const ADVISORY_SOURCE_PATTERNS: readonly SourcePattern[] = Object.freeze([
  {
    kind: "trivially_satisfiable",
    pattern: /\b(?:valueOf|toString|\[\s*Symbol\s*\.\s*toPrimitive\s*\])\s*\(\s*\)\s*\{/,
    detail:
      "overrides a coercion hook (valueOf/toString/Symbol.toPrimitive). This is the shape of the " +
      "AlwaysEqual exploit Anthropic measured in production RL, where every assertion passes. " +
      "Advisory: the same shape is legitimate in a fixture builder.",
  },
  {
    kind: "trivially_satisfiable",
    pattern: /\btry\s*\{[\s\S]{0,4000}?\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    detail: "contains an empty catch block, which swallows the failure it was meant to surface.",
  },
]);

/* -------------------------------------------------------------------------
 * 5. Syntax check
 * ---------------------------------------------------------------------- */

export interface SyntaxCheckResult {
  readonly path: string;
  /** Redacted compiler message, or null when the file parses. */
  readonly problem: string | null;
}

/**
 * Syntax-check every draft file with `node --check`.
 *
 * Verified behaviour (node v25.9.0): `node --check file.mjs` parses ESM,
 * including `import`, `export` and top-level `await`, exits 0 on success and
 * exits 1 with a `SyntaxError` on failure. This is why the suite is `.mjs`
 * rather than TypeScript — a TS suite would put a compiler inside the sealed
 * scorer image, which is a second thing that must be held constant.
 *
 * A file that does not parse fails 100% of runs in 100% of configurations. It
 * must never reach a build.
 */
export function syntaxCheckDraft(
  files: readonly DraftTestFile[],
  nodeExecPath: string = process.execPath,
): readonly SyntaxCheckResult[] {
  if (files.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "bakeoff-suite-syntax-"));
  try {
    return files.map((file) => {
      // The suite manifest is JSON, not ESM. `node --check` on it reports a
      // syntax error at the first colon, which is true and useless. It is
      // parsed — far more strictly — by `parseSuiteManifest`.
      if (isSuiteManifestPath(file.path)) {
        try {
          JSON.parse(file.source);
          return { path: file.path, problem: null };
        } catch (error) {
          return {
            path: file.path,
            problem: safe(
              `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            ),
          };
        }
      }
      // Flatten so `holdout/x.test.mjs` and `visible/x.test.mjs` cannot collide.
      // `--check` never resolves imports, so a flat layout is equivalent.
      const flat = `${file.visibility}__${file.path.split("/").slice(1).join("_") || "unnamed.mjs"}`;
      const target = join(dir, flat.endsWith(".mjs") ? flat : `${flat}.mjs`);
      writeFileSync(target, file.source, "utf8");
      const result = spawnSync(nodeExecPath, ["--check", target], {
        encoding: "utf8",
        timeout: 20_000,
        // No stdin, no inherited environment surprises. `--check` needs neither.
        env: { PATH: process.env["PATH"] ?? "" },
      });
      if (result.error !== undefined) {
        return { path: file.path, problem: `could not run "${nodeExecPath} --check": ${safe(String(result.error.message))}` };
      }
      if (result.status === 0) return { path: file.path, problem: null };
      const message = `${result.stderr ?? ""}`.trim().split("\n").slice(0, 12).join("\n");
      return { path: file.path, problem: safe(message.length > 0 ? message : `node --check exited ${String(result.status)}`) };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------
 * 6. Heuristics
 * ---------------------------------------------------------------------- */

/**
 * Env-var REFERENCES, in the three forms a test file writes them.
 *
 * Masked before the credential scan runs. `const apiKey = process.env.API_KEY`
 * is the CORRECT way for a test to obtain a secret — it names a variable and
 * never embeds a value — but it also matches redact.ts's SECRET_ASSIGNMENT
 * rule character for character ("apiKey", "=", a 19-character value with no
 * spaces). Without this mask, every suite that reads configuration from the
 * environment is thrown away and re-authored, repeatedly, for doing the right
 * thing. Masking a reference cannot hide a literal: `"sk-ant-..."` has no
 * `process.env` prefix and still fires.
 */
const ENV_REFERENCE_PATTERN =
  /\bprocess\s*\.\s*env\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(['"`])[^'"`]*\1\s*\])/g;

function maskEnvReferences(source: string): string {
  return source.replace(new RegExp(ENV_REFERENCE_PATTERN.source, ENV_REFERENCE_PATTERN.flags), "ENVREF");
}

/**
 * Blank every comment, preserving offsets and line structure.
 *
 * WHY THIS EXISTS, and it was found by the regression it caused rather than by
 * review. `bakeoff/test/scorer-modes.e2e.mjs` carried a gratuitous
 * `rendered.length > 20` bar in a throwaway suite. Removing it did NOT clear
 * rule 1's finding, because the commit that removed it left a comment saying
 * what the assertion used to read — and the rule matched the COMMENT. The e2e
 * stayed red at 14/16 with the defect already gone.
 *
 * A COMMENT CAN ONLY EVER BE A FALSE POSITIVE. It does not execute, so it can
 * never fail a correct artefact. Rule 1 is BLOCKING: it discards the suite and
 * spends another authoring call. A rule that forces regeneration over a line of
 * prose is worse than the bar it was written to catch, and it would fire hardest
 * on exactly the suites whose author bothered to explain itself.
 *
 * OFFSETS ARE PRESERVED — comment bodies become spaces, newlines survive —
 * because `testSegments` slices by index. A masker that shortened the source
 * would silently re-attribute every assertion after the first comment to the
 * wrong test id, which is a far worse defect than the one being fixed.
 *
 * THE DIRECTION OF ERROR THAT MATTERS IS THE OTHER ONE. Masking too much makes
 * a real bar invisible, and a detector that goes quiet is this repository's
 * signature defect. So string and template bodies are walked rather than
 * skipped, `//` inside a string stays code, and regex literals are recognised —
 * `.replace(/\s+/g, " ")` appears verbatim in the real frozen fixtures, and a
 * masker that mistook its slashes for a comment would blank the innerText
 * producer beside it and turn the whole rule off for that file.
 */
function maskComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  // A `/` starts a regex literal only where a value cannot already have ended.
  // After an identifier, a digit, or a closing bracket it is division.
  const regexMayStart = (at: number): boolean => {
    for (let k = at - 1; k >= 0; k -= 1) {
      const prev = source[k] ?? "";
      if (/\s/.test(prev)) continue;
      return !/[A-Za-z0-9_$)\]]/.test(prev);
    }
    return true;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === c) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "/" && regexMayStart(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const r = source[j];
        if (r === "\\") {
          j += 2;
          continue;
        }
        if (r === "\n") break; // unterminated: it was division after all
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const ASSERTION_PATTERN = /\b(?:assert|expect|should)\b/;

/**
 * Test bodies with no assertion-like call anywhere between one declared test id
 * and the next.
 *
 * ADVISORY. The segmentation is by test-id occurrence, not by parsing, so a
 * helper defined between two tests can move an assertion out of the segment
 * this looks at. doc 02 section 5.6 names the deterministic answer to
 * assertion-free tests — "mutation score threshold on the holdout suite" — and
 * that is a scorer-side gate on a built artefact, not something the author can
 * run before any implementation exists.
 *
 * IT USES {@link testSegments} RATHER THAN ITS OWN `indexOf`, and that is the
 * fix rather than a tidy-up. `indexOf("T-1")` has no word boundary, so in a file
 * holding both `T-1` and `T-13` where `T-13` is written first, `T-1` resolves to
 * a position INSIDE `T-13` — two segments then start at the same offset, the
 * ordering between them is whatever `sort` does with equal keys, and every
 * assertion after that point is attributed to the wrong test. `testSegments`
 * already anchors on `(?<![A-Za-z0-9_])id(?![A-Za-z0-9_])` for exactly this
 * reason and is used by the two checks either side of this one; a second,
 * weaker segmentation in the same file was the whole defect.
 *
 * A CONSEQUENCE WORTH STATING: a declared id that appears ONLY as a prefix of
 * another id now matches nothing and is not reported here. That is right. It is
 * an ABSENT test, not a vacuous one, and `expectedTestIds` coverage is checked
 * elsewhere; reporting it as assertion-free would name the wrong defect.
 */
function assertionFreeTestIds(file: DraftTestFile): readonly string[] {
  return testSegments(file)
    .filter((segment) => !ASSERTION_PATTERN.test(segment.text))
    .map((segment) => segment.testId);
}

const STRING_LITERAL_PATTERN = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function stringLiterals(source: string): ReadonlySet<string> {
  const out = new Set<string>();
  const pattern = new RegExp(STRING_LITERAL_PATTERN.source, STRING_LITERAL_PATTERN.flags);
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    const body = match[2] ?? "";
    if (body.length >= 3) out.add(body);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    match = pattern.exec(source);
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Fixture-overlap threshold above which a visible/held-out pair is flagged. */
const FIXTURE_OVERLAP_ADVISORY_THRESHOLD = 0.9;

/* -------------------------------------------------------------------------
 * 6b. Criterion attribution — the titles the scorer reads
 * ---------------------------------------------------------------------- */

/**
 * The first string-literal argument of every `test(...)`, `it(...)` and
 * `describe(...)` call in a source file.
 *
 * This is deliberately a lexical scan and not a parse: the audit must be able
 * to say something about a file it can read, without taking a dependency on a
 * JS parser inside a module that already refuses to execute the suite. It
 * accepts `test.describe`, `test.each`, `it.concurrent` and friends, and both
 * quote styles plus backticks — a template literal with no substitution is a
 * perfectly ordinary test title.
 *
 * A false NEGATIVE here (a title this misses) costs one regeneration. A false
 * POSITIVE would let through the defect this exists to catch, so the pattern
 * requires the literal to be the first argument rather than merely nearby.
 */
export function testTitleLiterals(source: string): readonly string[] {
  const pattern = /\b(?:test|it|describe)(?:\.[A-Za-z_$][\w$]*)*\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  const titles: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    const title = match[2];
    if (title !== undefined) titles.push(title);
    match = pattern.exec(source);
  }
  return titles;
}

/**
 * Does `title` carry `criterionId` the way the SCORER matches it?
 *
 * The boundary rule is copied deliberately from `attributeCriteria` in
 * scorer-container.ts: `(?<![A-Za-z0-9_])REQ-001(?![A-Za-z0-9_])`. Two
 * different notions of "carries the token" between the auditor and the scorer
 * would be worse than none, because the audit would then pass a suite the
 * scorer scores as unasserted — which is exactly the failure this check exists
 * to prevent. Note that `[` and `]` are not word characters, so the documented
 * `[REQ-004] T-14 ...` form matches, and `REQ-0041` does not.
 */
export function criterionTokenIn(title: string, criterionId: string): boolean {
  const escaped = criterionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(title);
}

/* -------------------------------------------------------------------------
 * 6c. Bars the ticket never asked for
 *
 * MEASURED, NOT THEORISED. Authoring-calibration run 4B
 * (dashboard/results/calibration-4b/2026-07-29T05-37-40-117Z) had the real spec
 * seat author 12 criteria from a three-sentence portfolio ticket, with no
 * knowledge of any fixture, and ran them against seven artefacts. Zero false
 * passes: the blank page failed correctly. But SEVEN of the twelve criteria
 * failed on EVERY artefact including the correct one, so a correct portfolio
 * graded `fail`. The container's own words on the correct artefact:
 *
 *     the page renders only 189 characters of text   Expected: > 200
 *     project "Note G" carries only 26 characters of description
 *
 * Neither number is in the ticket. Two inventions recurred VERBATIM across three
 * independent authoring runs — a per-description character floor and a
 * contact-form field set — which is what makes this worth a deterministic rule
 * rather than a prompt line. The prompt already says "Do not invent user stories
 * the ticket did not ask for" and the seat invented them anyway.
 *
 * THE OBVIOUS RULE IS WRONG. "A number the ticket does not state" destroys the
 * criteria that did the discriminating: the same run separated the blank page
 * from the correct portfolio with an HTTP 200, a 28px font size, a 900px fold
 * and a 375px viewport — none of them in the ticket, all of them legitimate.
 * And REQ-005's `>= 3` IS ticket-sourced, but the ticket spells it "three", so a
 * digit scan false-positives on the one bar that is justified.
 *
 * The line that separates them is not the number, it is what the number is
 * counting: a CHARACTER COUNT OF AUTHORED PROSE (200 characters of body text,
 * 40 characters per project description, 40 characters of meta description)
 * versus a STRUCTURAL OR DIMENSIONAL CONSTANT (a status code, a CSS pixel size,
 * a viewport width, a count of required entities). Nobody can satisfy the first
 * kind by doing the work correctly — the correct portfolio rendered 189
 * characters — because "enough prose" is not an observable the ticket defined.
 * ---------------------------------------------------------------------- */

/**
 * A `.length` floor at or above this many characters is read as a PROSE bar;
 * below it, as a count of things.
 *
 * HARNESS CHOICE. In the calibration suite every non-prose `.length` floor is 0,
 * 1 or 3 (an element exists; a lang attribute is non-trivial; three projects)
 * and every prose bar is 40, 150 or 200. Any cut in (5, 40] gives the same
 * verdict on every one of the twelve criteria, so this constant is not fitted to
 * the observation. 20 is chosen because a floor below twenty characters is not a
 * demand for prose in any case — it is a demand that a string be non-trivial.
 */
export const PROSE_LENGTH_FLOOR_MIN = 20;

/**
 * Expressions that read text a PERSON WROTE AND A BROWSER RENDERED.
 *
 * Closed list, deliberately. Each entry is a Playwright or DOM accessor whose
 * value is authored copy: `innerText`/`textContent` for rendered body text,
 * `getAttribute("content")` for a meta description, `inputValue` for a field's
 * displayed value. `innerHTML` is NOT here — markup is not prose.
 */
const RENDERED_TEXT_PATTERN =
  /\binnerText\b|\btextContent\b|\ballInnerTexts\s*\(|\ballTextContents\s*\(|getAttribute\s*\(\s*['"`]content['"`]\s*\)|\binputValue\s*\(/;

/**
 * Expressions that read MARKUP OR A TRANSPORT PAYLOAD rather than prose.
 *
 * `assert.ok(body.length >= 200)` on `await response.text()` is a legitimate
 * "the server did not serve an empty document" check and must not be flagged.
 * This is what keeps REQ-001 quiet even in the one file where it shares an
 * import block with a rendered-text bar (visible/site-basics.spec.mjs holds
 * REQ-001's `page.content()` 300-char floor and REQ-002's `innerText` 150-char
 * floor together).
 */
const HTML_SOURCE_PATTERN = /\.\s*content\s*\(\s*\)|\.\s*text\s*\(\s*\)|\binnerHTML\b|\bouterHTML\b/;

/** A member chain with no NESTED call parentheses, e.g. `a.b(x, y).c[0]`. */
const MEMBER_CHAIN_SOURCE = String.raw`[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?(?:\s*(?:\.\s*[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?|\[[^\]]*\]))*`;

/** `<chain>.length`, capturing the chain. */
const LENGTH_RECEIVER_PATTERN = new RegExp(`(${MEMBER_CHAIN_SOURCE})\\s*\\.\\s*length\\b`, "g");

/** A Playwright/Jest lower-bound matcher with a bare integer argument. */
const FLOOR_MATCHER_PATTERN = /\.\s*toBeGreaterThan(?:OrEqual)?\s*\(\s*(\d+)\s*\)/g;

/** `>= 200` / `> 200` written directly after the `.length`, the node:test form. */
const INLINE_FLOOR_PATTERN = /^\s*>=?\s*(\d+)/;

/**
 * The start of an assertion call. Used to cut a test body into WINDOWS, one per
 * assertion, so a `.length` in one statement is never paired with a threshold
 * from the next. Everything before the first assertion in a test — fixture
 * setup, a `page.evaluate` block, a helper call — falls outside every window and
 * is not scanned, which is why `if (entries.length < 3)` inside an extraction
 * routine is not mistaken for an assertion.
 */
const ASSERTION_CALL_PATTERN = /\b(?:expect|assert(?:\s*\.\s*[A-Za-z_$][\w$]*)?)\s*\(/g;

/** English number words, for a ticket or statement that spells its bar out. */
const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
});

/** Does `text` state `value`, as a digit run or as an English word? */
export function statesNumber(text: string, value: number): boolean {
  if (new RegExp(`(?<![\\d.])${String(value)}(?![\\d])`).test(text)) return true;
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (n === value && new RegExp(`\\b${word}\\b`, "i").test(text)) return true;
  }
  return false;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One test's slice of a file, from its declared id to the next one's. */
interface TestSegment {
  readonly testId: string;
  readonly text: string;
}

/**
 * Cut a file into one segment per declared test id.
 *
 * Boundary-aware, unlike a bare `indexOf`: in a file holding both `T-1` and
 * `T-13`, `indexOf("T-1")` can land inside `T-13` and mis-attribute every
 * assertion after it.
 */
function testSegments(file: DraftTestFile): readonly TestSegment[] {
  const positions = file.expectedTestIds
    .map((id) => ({
      id,
      at: file.source.search(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(id)}(?![A-Za-z0-9_])`)),
    }))
    .filter((p) => p.at >= 0)
    .sort((a, b) => a.at - b.at);

  const out: TestSegment[] = [];
  for (let i = 0; i < positions.length; i += 1) {
    const current = positions[i];
    if (current === undefined) continue;
    out.push({ testId: current.id, text: file.source.slice(current.at, positions[i + 1]?.at) });
  }
  return out;
}

/** One window per assertion call in `text`. */
function assertionWindows(text: string): readonly string[] {
  const starts: number[] = [];
  const pattern = new RegExp(ASSERTION_CALL_PATTERN.source, ASSERTION_CALL_PATTERN.flags);
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    starts.push(match.index);
    match = pattern.exec(text);
  }
  return starts.map((start, i) => text.slice(start, starts[i + 1]));
}

interface LengthFloor {
  /** The expression whose `.length` is bounded, e.g. `entry.description`. */
  readonly receiver: string;
  readonly threshold: number;
}

/** Every `<expr>.length >= N` / `expect(<expr>.length, ...).toBeGreaterThan(N)`. */
function lengthFloorsIn(window: string): readonly LengthFloor[] {
  const out: LengthFloor[] = [];
  const receivers = new RegExp(LENGTH_RECEIVER_PATTERN.source, LENGTH_RECEIVER_PATTERN.flags);
  let match: RegExpExecArray | null = receivers.exec(window);
  while (match !== null) {
    const receiver = (match[1] ?? "").trim();
    const after = match.index + match[0].length;
    const inline = INLINE_FLOOR_PATTERN.exec(window.slice(after));
    if (inline !== null) {
      out.push({ receiver, threshold: Number(inline[1]) });
    } else {
      // The matcher must come AFTER the `.length`, so trailing non-assertion
      // code in the window can never lend its `.length` to this threshold.
      const matchers = new RegExp(FLOOR_MATCHER_PATTERN.source, FLOOR_MATCHER_PATTERN.flags);
      matchers.lastIndex = after;
      const floor = matchers.exec(window);
      if (floor !== null) out.push({ receiver, threshold: Number(floor[1]) });
    }
    match = receivers.exec(window);
  }
  return out;
}

/** The single-line `const|let|var <ident> = ...` that introduced `ident`. */
function declarationInitialiser(source: string, ident: string): string | null {
  const match = new RegExp(
    `(?:^|[;{}\\n])\\s*(?:const|let|var)\\s+${escapeRegExp(ident)}\\s*=([^\\n]*)`,
  ).exec(source);
  return match === null ? null : (match[1] ?? null);
}

/**
 * True when the bounded value demonstrably came from markup or a transport
 * payload rather than from rendered prose.
 *
 * Deliberately a single-line lookup and not a taint analysis: it resolves the
 * root identifier's own declaration and nothing else. A chain that only becomes
 * markup inside a helper function's body is NOT resolved, and the file-level
 * producer gate is what covers that case (a file that reads no rendered text at
 * all is never scanned).
 */
function isMarkupLengthFloor(source: string, receiver: string): boolean {
  const root = /^[A-Za-z_$][\w$]*/.exec(receiver)?.[0];
  if (root === undefined) return false;
  const initialiser = declarationInitialiser(source, root);
  if (initialiser === null) return false;
  return HTML_SOURCE_PATTERN.test(initialiser) && !RENDERED_TEXT_PATTERN.test(initialiser);
}

/** Criteria that named `testId` as evidence, in either half. */
function criteriaOwning(draft: SuiteDraft, testId: string): readonly DraftCriterion[] {
  return draft.criteria.filter(
    (c) => c.holdoutTestIds.includes(testId) || c.visibleTestIds.includes(testId),
  );
}

/**
 * RULE 1 — a character-count floor asserted against rendered prose.
 *
 * BLOCKING, and that is a deliberate, expensive choice. `mustRegenerate` throws
 * the suite away and spends another Opus 5 `xhigh` authoring call, and this
 * module's own policy reserves that for checks that cannot be wrong about what
 * they saw. The justification is the measurement: a prose bar does not merely
 * add noise, it makes the criterion UNPASSABLE BY CORRECT WORK — it failed on
 * every one of the seven artefacts — and because the criterion still produces a
 * complete, plausible ScoreRecord, the defect is invisible downstream and reads
 * as "the model shipped a broken app". That is the same harm profile as the
 * REQ-id-in-title defect above, which is blocking for the same reason. An
 * advisory finding that nothing consumes would leave the measurement corrupt.
 *
 * `ticketBrief` is a PRECISION IMPROVEMENT, NOT A PRECONDITION. When it is
 * supplied and it states the number, the bar is ticket-sourced and the finding
 * is suppressed. When it is absent the rule still fires: a suite is far more
 * likely to have invented a prose bar than a caller is to have wired the ticket
 * through, and a rule that quietly disarms itself when an optional input is
 * missing is the exact shape of defect this tree keeps shipping.
 */
export function proseLengthFloorFindings(
  draft: SuiteDraft,
  ticketBrief?: string,
): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const rawFile of draft.files) {
    if (isSuiteManifestPath(rawFile.path)) continue;
    // COMMENTS ARE NOT CODE. Masked once, offsets preserved, and used for every
    // read below — the file-level gate, the segmentation and the markup
    // exclusion alike. Masking at only one of the three would leave the other
    // two matching prose. See `maskComments`.
    const file: DraftTestFile = { ...rawFile, source: maskComments(rawFile.source) };
    // FILE-LEVEL GATE. A file that never reads rendered text cannot be asserting
    // a floor on rendered text, whatever its numbers say. This is what keeps
    // REQ-001's `assert.ok(body.length >= 200)` on `await response.text()`
    // quiet: holdout/site-delivery.test.mjs contains no producer at all.
    if (!RENDERED_TEXT_PATTERN.test(file.source)) continue;

    for (const segment of testSegments(file)) {
      const seen = new Set<string>();
      for (const window of assertionWindows(segment.text)) {
        for (const floor of lengthFloorsIn(window)) {
          if (floor.threshold < PROSE_LENGTH_FLOOR_MIN) continue;
          if (isMarkupLengthFloor(file.source, floor.receiver)) continue;
          if (ticketBrief !== undefined && statesNumber(ticketBrief, floor.threshold)) continue;
          const key = `${floor.receiver}|${String(floor.threshold)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const detail =
            `test "${safe(segment.testId)}" in "${safe(file.path)}" asserts a character-count floor ` +
            `of ${String(floor.threshold)} on rendered text (\`${safe(floor.receiver)}.length\`)` +
            (ticketBrief === undefined
              ? ". "
              : `, and the ticket never states ${String(floor.threshold)}. `) +
            "How much prose an implementation writes is not an observable the ticket defined, so this " +
            "bar fails correct work: in calibration run 4B a correct portfolio rendered 189 characters " +
            "and this exact assertion failed it, on every artefact, alongside a 40-character " +
            "per-description floor. Assert the THING the ticket asked for — that the section exists, " +
            "that the entries are distinct, that the name renders — not that its copy is long enough.";
          const owners = criteriaOwning(draft, segment.testId);
          if (owners.length === 0) {
            findings.push(blocking("mis_specified", null, detail));
          } else {
            for (const owner of owners) findings.push(blocking("mis_specified", owner.id, detail));
          }
        }
      }
    }
  }
  return findings;
}

/**
 * RULE 3 — an assertion the criterion's own statement never mentions.
 *
 * Backlog #37. REQ-012's statement is "shall raise no uncaught JavaScript page
 * errors"; its test T-13 also demanded 200 characters of settled body text, and
 * THAT hidden second assertion is what failed the correct artefact. The
 * adversarial judge pass did not catch it. A criterion-level verdict cannot: the
 * statement is clean, the test is not.
 *
 * Scope, stated honestly: this is the NUMERIC slice of #37, not all of it. It
 * compares every bare integer threshold a held-out test asserts against the
 * numbers its criterion's statement states. A non-numeric hidden assertion — the
 * contact-form field set, say — is not reachable this way.
 *
 * TWO DELIBERATE NARROWINGS:
 *
 *   1. Against the STATEMENT ONLY, never `evidenceRequired`. The seat launders
 *      the invention into the evidence prose in the same breath it writes the
 *      test: REQ-012's evidence reads "...and the settled page still renders
 *      more than 200 characters of text". Consulting it would silence the one
 *      case this rule exists to catch.
 *   2. HELD-OUT tests only. The authoring prompt REQUIRES the visible twin to
 *      use different fixtures, values and seeds, so numeric divergence there is
 *      by design; and the held-out half is what decides `heldOutPass`.
 *
 * ADVISORY. 0 and 1 are skipped as existence quantifiers ("no images without
 * alt", "exactly one h1") which EARS states in words, and the residual fire rate
 * on the calibration suite is four criteria in twelve — two of them the real
 * defect, two of them defensible-but-noisy. That is a heuristic rate, and this
 * module does not spend an authoring call on a heuristic.
 */
export function numericAssertionDriftFindings(draft: SuiteDraft): readonly AuditFinding[] {
  const patterns: readonly RegExp[] = [
    /\.\s*(?:toBe|toEqual|toStrictEqual|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toHaveLength|toBeCloseTo)\s*\(\s*(-?\d+)\s*\)/g,
    /(?:>=|<=|===|!==|==|!=|(?<![=<>!])[<>])\s*(-?\d+)(?![\d.])/g,
    /\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*[^,()]*,\s*(-?\d+)\s*[,)]/g,
  ];

  const findings: AuditFinding[] = [];
  for (const rawFile of draft.files) {
    if (isSuiteManifestPath(rawFile.path) || rawFile.visibility !== "holdout") continue;
    // Same masking as rule 1, for the same reason: a number quoted in a comment
    // is not a threshold the test asserts. Advisory rather than blocking here,
    // so the cost of the false positive is a misleading finding rather than a
    // discarded suite — still worth not emitting.
    const file: DraftTestFile = { ...rawFile, source: maskComments(rawFile.source) };
    for (const segment of testSegments(file)) {
      const owners = criteriaOwning(draft, segment.testId).filter((c) =>
        c.holdoutTestIds.includes(segment.testId),
      );
      if (owners.length === 0) continue;

      const asserted = new Set<number>();
      for (const window of assertionWindows(segment.text)) {
        for (const source of patterns) {
          const pattern = new RegExp(source.source, source.flags);
          let match: RegExpExecArray | null = pattern.exec(window);
          while (match !== null) {
            const value = Number(match[1]);
            if (Number.isInteger(value) && Math.abs(value) > 1) asserted.add(value);
            match = pattern.exec(window);
          }
        }
      }

      for (const owner of owners) {
        for (const value of [...asserted].sort((a, b) => a - b)) {
          if (statesNumber(owner.statement, value)) continue;
          findings.push(
            advisory(
              "mis_specified",
              owner.id,
              `held-out test "${safe(segment.testId)}" in "${safe(file.path)}" asserts the numeric ` +
                `threshold ${String(value)}, which the criterion's own statement does not mention. ` +
                "A test that demands more than its statement claims fails a correct implementation " +
                "for a reason the statement never declared, and neither the statement nor the audit " +
                "report shows it — REQ-012 in calibration run 4B said only \"shall raise no uncaught " +
                "JavaScript page errors\" while its test also required 200 characters of body text, " +
                "and that hidden bar is what failed the correct artefact. Either state the threshold " +
                "in the statement or drop it from the test. Advisory: the numeric check cannot tell a " +
                "laundered invention from a genuine implied constant, so read the test.",
            ),
          );
        }
      }
    }
  }
  return findings;
}

/* -------------------------------------------------------------------------
 * 7. The deterministic audit
 * ---------------------------------------------------------------------- */

export interface DeterministicAuditOptions {
  /** Run `node --check` over every file. Default true. */
  readonly syntaxCheck?: boolean;
  /** Node executable used for the syntax check. Default `process.execPath`. */
  readonly nodeExecPath?: string;
  /**
   * The ticket's verbatim brief, when the caller has it.
   *
   * Used ONLY to suppress {@link proseLengthFloorFindings} when the ticket
   * itself states the character floor. Absent, the rule still fires — see its
   * doc comment. `auditSuite` in spec-agent.ts already holds the `Ticket` and
   * should pass `ticketBrief: ticket.brief` when it builds these options.
   */
  readonly ticketBrief?: string;
}

/**
 * The whole deterministic pass. No model, no network, no cost.
 *
 * Returns findings in the frozen {@link AuditFinding} shape so they ride on the
 * suite record next to the judge's findings and are indistinguishable to the
 * scorer, which is correct: the suite either passed its audit or it did not.
 */
export function deterministicAudit(
  draft: SuiteDraft,
  options: DeterministicAuditOptions = {},
): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];

  /* ---- criteria: identity, tiering, EARS, evidence ------------------ */

  if (draft.criteria.length > MAX_CRITERIA) {
    findings.push(
      blocking(
        "other",
        null,
        `${draft.criteria.length} criteria exceeds the cap of ${MAX_CRITERIA} (doc 02 section 5.4). ` +
          "Merge or drop the least load-bearing criteria; a rubric nobody can hold in mind is not graded consistently.",
      ),
    );
  }

  const seenCriterionIds = new Set<string>();
  for (const criterion of draft.criteria) {
    if (!REQ_ID_PATTERN.test(criterion.id)) {
      findings.push(
        blocking("other", criterion.id, `criterion id "${safe(criterion.id)}" is not of the form REQ-001`),
      );
    }
    if (seenCriterionIds.has(criterion.id)) {
      findings.push(blocking("other", criterion.id, `duplicate criterion id "${safe(criterion.id)}"`));
    }
    seenCriterionIds.add(criterion.id);

    for (const problem of statementProblems(criterion.statement)) {
      findings.push(
        problem.blocking
          ? blocking(problem.kind, criterion.id, `${problem.detail} Statement: ${safe(criterion.statement)}`)
          : advisory(problem.kind, criterion.id, `${problem.detail} Statement: ${safe(criterion.statement)}`),
      );
    }

    if (criterion.evidenceRequired.trim().length === 0) {
      findings.push(
        blocking(
          "mis_specified",
          criterion.id,
          "criterion names no evidence artefact. doc 02 section 5.4: a criterion that names no " +
            'artefact is how a judge passes a stub ("F3: Booking works" is the failing example).',
        ),
      );
    }
    if (criterion.holdoutTestIds.length === 0) {
      findings.push(
        blocking(
          "mis_specified",
          criterion.id,
          "criterion is bound to no HELD-OUT test. Every criterion is decided by the held-out half; " +
            "a criterion with only visible evidence is decided by tests the builder can read.",
        ),
      );
    }
    const named = criterion.holdoutTestIds.some((id) => criterion.evidenceRequired.includes(id));
    if (criterion.holdoutTestIds.length > 0 && !named) {
      findings.push(
        blocking(
          "mis_specified",
          criterion.id,
          `evidenceRequired does not name any of its held-out test ids ` +
            `(${criterion.holdoutTestIds.join(", ")}). The prose and the binding must agree, ` +
            "otherwise the prose is decoration.",
        ),
      );
    }
    for (const id of [...criterion.holdoutTestIds, ...criterion.visibleTestIds]) {
      if (!TEST_ID_PATTERN.test(id)) {
        findings.push(blocking("other", criterion.id, `test id "${safe(id)}" is not of the form T-14`));
      }
    }
  }

  const tierCount = (tier: CriterionTier): number => draft.criteria.filter((c) => c.tier === tier).length;
  if (tierCount("BLOCKING") === 0) {
    findings.push(
      blocking(
        "mis_specified",
        null,
        "no BLOCKING-tier criterion. doc 02 section 5.4 puts builds/boots/suite-passes/no-protected-file-" +
          "modification in the BLOCKING tier, and all of them must pass to ship.",
      ),
    );
  }
  if (tierCount("FUNCTIONAL") === 0) {
    findings.push(
      blocking(
        "mis_specified",
        null,
        "no FUNCTIONAL-tier criterion. doc 02 section 5.4 requires one criterion per user story in the " +
          "ticket, at 100%. A suite with none gates on nothing the ticket actually asked for.",
      ),
    );
  }

  /* ---- files: paths, ids, sources ----------------------------------- */

  const filesByPath = new Map<string, DraftTestFile>();
  const testIdOwner = new Map<string, DraftTestFile>();

  for (const file of draft.files) {
    for (const problem of pathProblems(file.path)) {
      findings.push(blocking("other", null, `test file "${safe(file.path)}": ${problem}`));
    }
    if (filesByPath.has(file.path)) {
      findings.push(blocking("other", null, `duplicate test file path "${safe(file.path)}"`));
    }
    filesByPath.set(file.path, file);

    const pathVisibility = visibilityOfPath(file.path);
    if (pathVisibility !== null && pathVisibility !== file.visibility) {
      findings.push(
        blocking(
          "other",
          null,
          `test file "${safe(file.path)}" declares visibility "${file.visibility}" but its path says ` +
            `"${pathVisibility}". The path is what the freeze digest covers, so the two must agree.`,
        ),
      );
    }
    const pathRunner = runnerOfPath(file.path);
    if (pathRunner !== null && pathRunner !== file.runner) {
      findings.push(
        blocking(
          "other",
          null,
          `test file "${safe(file.path)}" declares runner "${file.runner}" but its suffix implies ` +
            `"${pathRunner}" (${RUNNER_SUFFIX[file.runner]} is required for ${file.runner}).`,
        ),
      );
    }

    if (file.source.trim().length === 0) {
      findings.push(blocking("vacuous", null, `test file "${safe(file.path)}" is empty`));
    }
    // The suite manifest is a DECLARATION, not a test: it contains no test ids
    // by definition, and demanding some would make the one file the sealed
    // scorer requires permanently unauthorable. Its contents are validated far
    // more strictly than any test file, by `parseSuiteManifest` — which is
    // called RIGHT HERE, at authoring time, and not only inside the container.
    //
    // WHY IT IS CALLED HERE. The container is the only other place that parses
    // it, and by then the suite is frozen, the builds have run and the money is
    // spent: an unscorable manifest would surface as a scoring failure across
    // every configuration at once, which is indistinguishable in the report
    // from every model having failed. Authoring can regenerate (see
    // DEFAULT_MAX_AUTHORING_ATTEMPTS), so the seat gets the parser's own
    // remediation text and another attempt, for free, before anything is built.
    if (isSuiteManifestPath(file.path)) {
      // ONE REJECTION NAMES EVERY OFFENDING FIELD, not the first.
      //
      // `parseSuiteManifest`'s `fail()` is typed `never`, so it throws at the
      // first defect and a feedback turn built from it can only ever carry one
      // field. Run `a913c871` (2026-08-09) burned 1h26m54s on that channel: the
      // seat was told "missing id", added `id` and was told "missing kind",
      // added `kind` and dropped the `id`. `collectManifestProblems` surveys
      // the document with the SAME parser and returns every field it can
      // isolate; its first entry is always the parser's own first complaint, so
      // this can never say less than the fail-fast path said.
      //
      // ONE FINDING PER PROBLEM, deliberately. `blockingFindingSummary` renders
      // one line per finding, and that is the shape the next attempt's prompt
      // carries. A single finding with the fields joined into one sentence
      // would be one line however many fields it names.
      let problems: readonly ManifestProblem[];
      try {
        problems = collectManifestProblems(JSON.parse(file.source) as unknown);
      } catch (error) {
        // The source is not JSON at all, so nothing can be surveyed. This is
        // the one manifest defect that genuinely has a single cause.
        problems = [
          {
            field: file.path,
            message: error instanceof Error ? error.message : String(error),
            remediation: "Emit the manifest as a complete JSON document, not as JavaScript.",
          },
        ];
      }
      for (const problem of problems) {
        findings.push(
          blocking(
            "other",
            null,
            `the suite manifest "${safe(file.path)}" is not executable by the sealed scorer: ` +
              `${safe(problem.message)} :: ${safe(problem.remediation)}`,
          ),
        );
      }
    }
    if (file.expectedTestIds.length === 0 && !isSuiteManifestPath(file.path)) {
      findings.push(
        blocking(
          "vacuous",
          null,
          `test file "${safe(file.path)}" declares no test ids, so nothing in it can be attributed to a criterion`,
        ),
      );
    }

    for (const id of file.expectedTestIds) {
      if (!TEST_ID_PATTERN.test(id)) {
        findings.push(blocking("other", null, `test file "${safe(file.path)}": test id "${safe(id)}" is not of the form T-14`));
      }
      const owner = testIdOwner.get(id);
      if (owner !== undefined) {
        findings.push(
          blocking(
            "other",
            null,
            `test id "${safe(id)}" is declared by both "${safe(owner.path)}" and "${safe(file.path)}". ` +
              "Test ids must be unique so a criterion's evidence resolves to exactly one test.",
          ),
        );
      }
      testIdOwner.set(id, file);

      if (!file.source.includes(id)) {
        findings.push(
          blocking(
            "vacuous",
            null,
            `test file "${safe(file.path)}" declares test id "${safe(id)}" but the id does not appear ` +
              "anywhere in its source. The scorer matches reported test names against these ids; a " +
              "declared-but-absent id reports as a missing test forever.",
          ),
        );
      }
    }

    const titles = testTitleLiterals(file.source);
    for (const criterionId of file.criterionIds) {
      if (!seenCriterionIds.has(criterionId)) {
        findings.push(
          blocking(
            "other",
            criterionId,
            `test file "${safe(file.path)}" claims to cover unknown criterion "${safe(criterionId)}"`,
          ),
        );
      } else if (!titles.some((title) => criterionTokenIn(title, criterionId))) {
        // MEASURED, NOT THEORISED. A suite authored against an earlier version
        // of the authoring prompt put only T-ids in its titles. Every gate
        // passed, 24 of 24 tests passed, and all 12 criteria came back
        // `unasserted` — heldOutPass false, falseFinish true, on a correct
        // artefact. The scorer's `attributeCriteria` matches the criterion's
        // REQ-id against the test's TITLE PATH and nothing else, so a title
        // without it asserts nothing however good the test is.
        //
        // The prompt now says so, and this is the check that makes the prompt
        // enforceable: this tree's own standard is that a prompt instruction is
        // not sufficient. Regeneration is the right response because the defect
        // is invisible downstream — it produces a complete, plausible
        // ScoreRecord that reads as "the model shipped a broken app".
        findings.push(
          blocking(
            "mis_specified",
            criterionId,
            `test file "${safe(file.path)}" is declared to cover "${safe(criterionId)}" but no test or ` +
              `describe TITLE in it carries that id. The scorer attributes a criterion to a test by ` +
              `finding the criterion's REQ-id in the test's title path; a title carrying only a T-id ` +
              `asserts nothing, and the criterion is scored UNASSERTED — which fails, even when the ` +
              `test passes. Name the criterion in the title, e.g. ` +
              `test("[${safe(criterionId)}] T-1 ...").`,
          ),
        );
      }
    }

    if (file.visibility === "visible" && /\bholdout\s*\//.test(file.source)) {
      findings.push(
        blocking(
          "leaks_implementation",
          null,
          `visible test file "${safe(file.path)}" references a "holdout/" path. The visible half is ` +
            "copied into the builder's workspace; a reference to the held-out half leaks the sealed " +
            "suite and destroys the whole measurement.",
        ),
      );
    }

    // COMMENTS ARE MASKED HERE, AND THE POLICY SAYING SO WAS ALREADY WRITTEN — see
    // `maskComments`' own docblock above: "A COMMENT CAN ONLY EVER BE A FALSE
    // POSITIVE … A rule that forces regeneration over a line of prose is worse
    // than the bar it was written to catch, and it would fire hardest on exactly
    // the suites whose author bothered to explain itself."
    //
    // That masking was applied to the three ADVISORY rules and never to this
    // loop, which is the only one that can throw the suite away. So
    // `// the artefact must not render "Not Implemented"` discarded an entire
    // suite and burned one of three attempts — punishing the seat for
    // documenting its own test. Run 0629aa6c died on a `not implemented` marker;
    // this is one of the two ways that can happen without a defect in a test.
    const scanned = maskComments(file.source);
    for (const rule of BLOCKING_SOURCE_PATTERNS) {
      if (rule.pattern.test(scanned)) {
        findings.push(blocking(rule.kind, null, `test file "${safe(file.path)}" ${rule.detail}`));
      }
    }
    for (const rule of ADVISORY_SOURCE_PATTERNS) {
      if (rule.pattern.test(file.source)) {
        findings.push(advisory(rule.kind, null, `test file "${safe(file.path)}" ${rule.detail}`));
      }
    }

    /* -- credential-shaped fixtures --------------------------------------
     * Detection only. The bytes are never rewritten: the frozen file and the
     * frozen digest must stay identical, and a redactor that edited a fixture
     * would break `assertSuiteDigestMatches` permanently.
     *
     * Vendor-shaped matches are BLOCKING: a suite carrying a credential-shaped
     * literal is one this harness can never safely log about, and every finding
     * and log line about it is scrubbed from that point on.
     *
     * The generic high-entropy rule is ADVISORY: a 40-character mixed-case
     * blob is also what a legitimate base64 fixture or a data URI looks like,
     * and a false positive here costs a whole authoring cycle.
     */
    const scannable = maskEnvReferences(file.source);
    const shaped = redactText(scannable, { entropyScan: false });
    if (shaped.redacted) {
      findings.push(
        blocking(
          "other",
          null,
          `test file "${safe(file.path)}" contains credential-shaped literal(s): ` +
            `${shaped.findings.map((f) => `${f.rule} x${f.count}`).join(", ")}. ` +
            "Use an obviously-fake fixture that no redaction rule matches. The offending value is " +
            "deliberately not quoted here.",
        ),
      );
    } else {
      const entropic = redactText(scannable, { entropyScan: true });
      if (entropic.redacted) {
        findings.push(
          advisory(
            "other",
            null,
            `test file "${safe(file.path)}" contains a high-entropy literal ` +
              `(${entropic.findings.map((f) => f.rule).join(", ")}). If it is a fixture this is fine; ` +
              "note that every log line quoting it will be scrubbed.",
          ),
        );
      }
    }

    for (const id of assertionFreeTestIds(file)) {
      findings.push(
        advisory(
          "vacuous",
          null,
          `test "${safe(id)}" in "${safe(file.path)}" appears to contain no assertion. ` +
            "Advisory: segmentation is by test-id position, so a shared helper can move the assertion " +
            "out of view. Read it before acting.",
        ),
      );
    }
  }

  /* ---- the split ---------------------------------------------------- */

  const holdoutFiles = draft.files.filter((f) => f.visibility === "holdout");
  const visibleFiles = draft.files.filter((f) => f.visibility === "visible");
  if (holdoutFiles.length === 0) {
    findings.push(
      blocking(
        "other",
        null,
        "the suite has no held-out test files. The held-out half is the gate; without it nothing is sealed.",
      ),
    );
  }
  if (visibleFiles.length === 0) {
    findings.push(
      blocking(
        "other",
        null,
        "the suite has no visible test files. doc 03 section 7.5 requires the gap between the visible " +
          "and held-out pass rates to be reported, and that gap is undefined without a visible half.",
      ),
    );
  }

  const knownTestIds = new Set(testIdOwner.keys());
  for (const criterion of draft.criteria) {
    for (const id of criterion.holdoutTestIds) {
      const owner = testIdOwner.get(id);
      if (owner === undefined) {
        if (knownTestIds.size > 0) {
          findings.push(
            blocking("mis_specified", criterion.id, `held-out evidence "${safe(id)}" is defined by no test file`),
          );
        }
      } else if (owner.visibility !== "holdout") {
        findings.push(
          blocking(
            "mis_specified",
            criterion.id,
            `"${safe(id)}" is listed as held-out evidence but lives in the VISIBLE file ` +
              `"${safe(owner.path)}". A criterion decided by a test the builder can read is not held out.`,
          ),
        );
      }
    }
    for (const id of criterion.visibleTestIds) {
      const owner = testIdOwner.get(id);
      if (owner === undefined) {
        if (knownTestIds.size > 0) {
          findings.push(
            blocking("mis_specified", criterion.id, `visible evidence "${safe(id)}" is defined by no test file`),
          );
        }
      } else if (owner.visibility !== "visible") {
        findings.push(
          blocking(
            "mis_specified",
            criterion.id,
            `"${safe(id)}" is listed as visible evidence but lives in the HELD-OUT file "${safe(owner.path)}"`,
          ),
        );
      }
    }
  }

  const paired = draft.criteria.filter(
    (c) => c.holdoutTestIds.length > 0 && c.visibleTestIds.length > 0,
  );
  if (paired.length === 0) {
    findings.push(
      blocking(
        "other",
        null,
        "no criterion has BOTH a held-out and a visible test. The visible-vs-held-out pass-rate gap " +
          "(doc 03 section 7.5, doc 02 section 5.4) is the reward-hacking metric and it is undefined " +
          "without at least one paired criterion.",
      ),
    );
  }

  const functional = draft.criteria.filter((c) => c.tier === "FUNCTIONAL");
  const functionalPaired = functional.filter((c) => c.visibleTestIds.length > 0).length;
  const required = Math.max(1, Math.ceil(functional.length * MIN_VISIBLE_FUNCTIONAL_FRACTION));
  if (functional.length > 0 && functionalPaired < required) {
    findings.push(
      advisory(
        "other",
        null,
        `only ${functionalPaired} of ${functional.length} FUNCTIONAL criteria have a visible twin ` +
          `(target: at least ${required}). The gap will be computed over a small denominator and will ` +
          "be noisy. Harness target, not a doc-prescribed threshold.",
      ),
    );
  }

  /* ---- fixtures actually varied ------------------------------------- */

  const holdoutBySource = new Map<string, DraftTestFile>();
  for (const file of holdoutFiles) holdoutBySource.set(file.source, file);
  for (const file of visibleFiles) {
    const twin = holdoutBySource.get(file.source);
    if (twin !== undefined) {
      findings.push(
        blocking(
          "trivially_satisfiable",
          null,
          `visible file "${safe(file.path)}" is byte-identical to held-out file "${safe(twin.path)}". ` +
            "The visible half must test the same requirement with DIFFERENT fixtures, values and " +
            "seeds; identical files make the gap structurally zero and hide overfitting completely " +
            "(doc 02 section 5.6: randomised fixtures/seeds per run).",
        ),
      );
      continue;
    }
    const visibleLiterals = stringLiterals(file.source);
    for (const holdout of holdoutFiles) {
      const shared = jaccard(visibleLiterals, stringLiterals(holdout.source));
      if (shared >= FIXTURE_OVERLAP_ADVISORY_THRESHOLD) {
        findings.push(
          advisory(
            "trivially_satisfiable",
            null,
            `visible file "${safe(file.path)}" shares ${(shared * 100).toFixed(0)}% of its string ` +
              `literals with held-out file "${safe(holdout.path)}". A builder that hardcodes the ` +
              "visible fixtures would also pass the held-out half, which suppresses the gap.",
          ),
        );
        break;
      }
    }
  }

  /* ---- bars the ticket never asked for ------------------------------ */

  findings.push(...proseLengthFloorFindings(draft, options.ticketBrief));
  findings.push(...numericAssertionDriftFindings(draft));
  findings.push(...unstatedEnvContractFindings(draft, options.ticketBrief));
  findings.push(...shapeHeuristicProbeFindings(draft));

  /* ---- syntax ------------------------------------------------------- */

  if (options.syntaxCheck ?? true) {
    for (const result of syntaxCheckDraft(draft.files, options.nodeExecPath ?? process.execPath)) {
      if (result.problem === null) continue;
      findings.push(
        blocking(
          "other",
          null,
          `test file "${safe(result.path)}" does not parse as ESM:\n${result.problem}`,
        ),
      );
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------
 * RULE 4 — a held-out criterion that turns on an environment variable name the
 *          ticket never states.
 *
 * THE RUN THIS EXISTS FOR. `54927ebc`, 2026-08-10: 7 of 7 FUNCTIONAL criteria
 * failed together, every one of them a criterion that reads a message back. One
 * cause. The ticket required a bearer token from "an environment variable" and
 * never named it. The suite is authored from the ticket ALONE, before any code
 * exists, so it had to invent a name; the builder had to invent one too; nothing
 * in the pipeline made the two agree. One 401 failed every read-back criterion
 * at once, and the verdict read as seven separate defects in the artefact.
 *
 * WHY IT IS THE CLASS FIX AND NOT THE INSTANCE FIX. Publishing the suite's
 * literals to the builder repairs the tickets we have already seen. This refuses
 * to FREEZE a criterion that cannot be graded fairly, whatever the literal is —
 * so the run fails at the audit, in seconds, naming the ambiguity, instead of
 * after 3 h 18 m as a false verdict about the artefact.
 *
 * WHY IT LIVES HERE AND NOT IN `freezeSuite`. `FreezeSuiteInput` carries no
 * ticket brief, only a digest of it, so freeze time is structurally incapable of
 * asking "did the owner state this?". It needs no new refusal site: a finding
 * with `mustRegenerate` already clears `auditPassed` (spec-agent.ts) and
 * `freezeSuite` already refuses on it via `assertSuiteUsable`, kind-agnostically.
 *
 * IT FIRES ON A REAL, ALREADY-PAID-FOR DEFECT. Over every frozen suite on disk
 * the `process.env` reads are `APP_BASE_URL` (17) and `APP_ROOT` (2). The first
 * is genuinely harness-supplied and is exempt. The second is not supplied by
 * anything — see the note on `HARNESS_ENV_NAMES` — and those two reads are
 * exactly the two tests that failed unconditionally on run `54927ebc`, costing
 * REQ-010 and REQ-011. So the honest fire rate is one suite in three, and the
 * one it fires on is the one that was mis-graded.
 *
 * ADVISORY ON PURPOSE, FOR NOW. It refuses nothing yet: three suites is not a
 * false-positive measurement, and this module's policy is to land advisory,
 * measure the real rate, then promote. Promotion is one word: `advisory` ->
 * `blocking`. Note that promoting it would have turned a 3 h 18 m run that
 * produced two wrong criteria into an authoring-time refusal in seconds.
 * ---------------------------------------------------------------------- */

/**
 * Names the HARNESS supplies, so the ticket cannot be expected to state them.
 *
 * NOT A CONVENIENCE LIST. Every entry is a name some part of this system sets or
 * documents, which is what makes it fair to exempt: the builder learns these from
 * the prompt or the container, not from the ticket. A name that is merely
 * *common* does not belong here — that is how an allowlist quietly becomes the
 * reason the rule never fires.
 */
/**
 * Names this rule must NOT fire on, and the two reasons a name may be here.
 *
 * THE CONTAINER-SUPPLIED HALF IS NOT LISTED — IT IS DERIVED, and that is the
 * whole point. For one draft this set contained `APP_ROOT`, on the strength of a
 * comment asserting `scorer-container.ts` injected it. Nothing did. So the
 * allowlist excused the single name in the entire corpus that was actually
 * broken: run `54927ebc`'s `holdout/contact-storage.test.mjs` resolved
 * `process.env.APP_ROOT ?? <walk up from cwd for a package.json>`, the node pass
 * runs with cwd `/opt/bakeoff-scorer` which has its own `package.json`, so the
 * walk stopped inside the scorer's install and never reached `/artifact`. T-14
 * and T-15 died on their first statement and REQ-010 and REQ-011 were published
 * as artefact defects. A hand-copied mirror of the container's env is the same
 * "two sides must agree on a literal" defect this rule exists to catch, one level
 * up — so it is asked, not copied.
 *
 * (`APP_ROOT` IS now supplied, as of the same session: `suiteEnv` sets it to
 * `CONTAINER_PATHS.artifact`. It is exempt again because it became TRUE, not
 * because it was re-listed.)
 */
function harnessEnvNames(): ReadonlySet<string> {
  return new Set([
    // Asked of the real container builder, never transcribed.
    ...SUITE_ENV_NAMES,
    // Stated to the builder in the harness-environment section of its prompt, so
    // the two sides can agree on it even though the container does not set it.
    "PORT",
    // Set by the platform for any Node process, in or out of this harness.
    "NODE_ENV",
    "TMPDIR",
  ]);
}

const HARNESS_ENV_NAMES: ReadonlySet<string> = harnessEnvNames();

/**
 * Does `text` state `token`, allowing for how a person writes a variable name in
 * prose? `BEARER_TOKEN` is stated by "BEARER_TOKEN", "bearer token" and
 * "bearer-token" alike.
 *
 * The string analogue of {@link statesNumber}, and deliberately GENEROUS in the
 * direction that keeps the rule quiet: a false negative here fires a finding on a
 * ticket that did state the name, which costs an authoring round. A false
 * positive stays silent on a ticket that did not, which costs what `54927ebc`
 * cost. Erring toward "stated" is the cheaper mistake while the rule is advisory,
 * and must be revisited if it is ever promoted to blocking.
 */
export function statesToken(text: string, token: string): boolean {
  const parts = token.split(/[_-]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  const pattern = parts.map((p) => escapeRegExp(p)).join("[\\s_-]*");
  return new RegExp(`\\b${pattern}\\b`, "i").test(text);
}

/** `process.env.NAME` and `process.env["NAME"]`, capturing the NAME. */
const ENV_NAME_PATTERN = /\bprocess\s*\.\s*env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`]*)\2\s*\])/g;

/** Every environment variable name `source` reads, in order of appearance. */
function envNamesRead(source: string): readonly string[] {
  const pattern = new RegExp(ENV_NAME_PATTERN.source, ENV_NAME_PATTERN.flags);
  const names: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    const name = match[1] ?? match[3];
    if (name !== undefined && name.length > 0) names.push(name);
    match = pattern.exec(source);
  }
  return names;
}

/**
 * Findings for held-out criteria that turn on an unstated environment variable.
 *
 * HELD-OUT ONLY, AND THAT IS THE WHOLE JUSTIFICATION FOR THE ASYMMETRY. The
 * visible half is COPIED INTO THE BUILDER'S WORKSPACE (`materialiseVisibleSubset`
 * takes exactly `visibility === "visible"`), so a name that appears there has
 * been published to the builder and the two sides can agree by reading. A name
 * that appears only in the held-out half has been published to nobody, and the
 * builder is being graded on guessing it.
 *
 * IT DOES NOT GO QUIET WHEN THE BRIEF IS MISSING. `ticketBrief` is optional on
 * `DeterministicAuditOptions`, and a rule whose comparand is absent could return
 * `[]` and look like a pass. That is the exact defect this tree keeps shipping,
 * so an absent brief emits its own finding saying the rule could not run.
 */
export function unstatedEnvContractFindings(
  draft: SuiteDraft,
  ticketBrief?: string,
): readonly AuditFinding[] {
  const holdout = draft.files.filter((f) => f.visibility === "holdout");

  // Names the builder CAN see, because the visible half is copied to it.
  const published = new Set<string>();
  for (const file of draft.files) {
    if (file.visibility !== "holdout") for (const name of envNamesRead(file.source)) published.add(name);
  }

  // name -> the criteria whose evidence reads it.
  const readers = new Map<string, Set<string>>();
  for (const file of holdout) {
    for (const name of envNamesRead(file.source)) {
      if (HARNESS_ENV_NAMES.has(name) || published.has(name)) continue;
      const owners = readers.get(name) ?? new Set<string>();
      for (const id of file.criterionIds) owners.add(id);
      readers.set(name, owners);
    }
  }

  if (readers.size === 0) return [];

  if (ticketBrief === undefined || ticketBrief.trim().length === 0) {
    return [
      advisory(
        "ambiguous",
        null,
        `the held-out half reads ${String(readers.size)} environment variable(s) — ` +
          `${[...readers.keys()].map((n) => safe(n)).join(", ")} — and no ticket brief was supplied ` +
          "to this audit, so it could not check whether the owner named them. This rule did NOT run; " +
          "treat its silence as unknown, not as a pass.",
      ),
    ];
  }

  const findings: AuditFinding[] = [];
  for (const [name, owners] of readers) {
    if (statesToken(ticketBrief, name)) continue;
    const ids = [...owners].sort();
    findings.push(
      advisory(
        "ambiguous",
        ids.length === 1 ? (ids[0] ?? null) : null,
        `the held-out half grades against the environment variable ${safe(name)}, which the ticket ` +
          `never names${ids.length === 0 ? "" : ` (criteria: ${ids.map((i) => safe(i)).join(", ")})`}. ` +
          "The suite is authored from the ticket alone and the builder is prompted from the ticket " +
          "alone, so both must invent this name independently and nothing makes them agree. When they " +
          "differ, every criterion that reads through this variable fails together, and the verdict " +
          "reports one ambiguity as many defects in the artefact. Either the ticket must name it, or " +
          "the suite must accept whatever the builder chose.",
      ),
    );
  }
  return findings;
}

/* -------------------------------------------------------------------------
 * RULE 5 — a probe that locates its subject by DOM SHAPE, then reports the
 *          measurement it never took.
 *
 * THE TWO CRITERIA THIS COST, ON THE SAME RUN. `54927ebc`'s
 * `holdout/motion-a11y.spec.mjs` looks for each project title with
 * `el.children.length === 0 && el.textContent.includes(title)` — a "leaf
 * element" heuristic — and on NOT FOUND pushes the title into an array called
 * `faded`, which is then asserted empty with the message *"these project cards
 * are hidden or faded when reduced motion is set"*. The artefact renders every
 * card at opacity 1. What it also renders, inside each heading, is the
 * hand-inked SVG underline THE TICKET ASKED FOR — so the heading has an element
 * child, no leaf matches, and four of six titles are reported as faded without
 * opacity ever being read. REQ-016 fails on the same heuristic in the same file.
 *
 * IT IS THE SIGNATURE DEFECT WITH THE SIGN FLIPPED. The catalogued version is a
 * probe that can only observe success. This is a probe that can only observe
 * failure: `<h2><span>Teewise</span><svg/></h2>` passes and
 * `<h2>Teewise<svg/></h2>` fails, and the criterion mentions neither. A correct
 * artefact cannot make it green except by accident of nesting.
 *
 * WHAT IT DOES NOT CLAIM. `children.length === 0` is not wrong everywhere — it is
 * wrong as the LOCATOR for a subject whose property you are about to assert,
 * because "no element matched" and "the property is bad" then become the same
 * outcome. The rule is therefore scoped to held-out browser tests, where a
 * false fire is invisible to the builder and lands as a defect in its verdict.
 * ---------------------------------------------------------------------- */

/** `children.length === 0`, `childElementCount === 0`, and the `!x.children.length` spelling. */
const LEAF_HEURISTIC_PATTERN =
  /(?:\.children\s*\.\s*length\s*===?\s*0|\.childElementCount\s*===?\s*0|!\s*[A-Za-z_$][\w$]*\s*\.\s*children\s*\.\s*length)/;

/**
 * Findings for held-out browser probes that select an element by leaf-shape.
 *
 * HELD-OUT AND PLAYWRIGHT ONLY. In the visible half the builder can read the
 * heuristic and satisfy it, so it is a stated contract rather than a trap; in a
 * `node-test` file there is no DOM and the pattern means something else.
 */
export function shapeHeuristicProbeFindings(draft: SuiteDraft): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const file of draft.files) {
    if (file.visibility !== "holdout" || file.runner !== "playwright") continue;
    if (!LEAF_HEURISTIC_PATTERN.test(maskComments(file.source))) continue;
    const ids = [...file.criterionIds].sort();
    findings.push(
      advisory(
        "mis_specified",
        ids.length === 1 ? (ids[0] ?? null) : null,
        `held-out browser test "${safe(file.path)}" locates an element by requiring it to have NO ` +
          `element children${ids.length === 0 ? "" : ` (criteria: ${ids.map((i) => safe(i)).join(", ")})`}. ` +
          "A subject found this way is lost the moment the artefact nests anything inside it — an icon, " +
          "an underline, a <span> — and the probe then reports the property it was going to measure as " +
          "failed, having never measured it. Locate by text or role and assert the property separately, " +
          "so 'not found' and 'measured bad' stay distinguishable.",
      ),
    );
  }
  return findings;
}

/** True when any finding requires the suite to be thrown away and re-authored. */
export function requiresRegeneration(findings: readonly AuditFinding[]): boolean {
  return findings.some((f) => f.mustRegenerate);
}

/** Blocking findings, formatted for a regeneration prompt. Already redacted. */
export function blockingFindingSummary(findings: readonly AuditFinding[]): readonly string[] {
  return findings
    .filter((f) => f.mustRegenerate)
    .map((f) => `[${f.kind}]${f.criterionId === null ? "" : ` ${f.criterionId}:`} ${f.detail}`);
}
