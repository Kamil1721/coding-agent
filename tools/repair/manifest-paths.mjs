/**
 * STRUCTURED FIELD PATHS FROM A MANIFEST DOCUMENT — the input the anti-loop
 * comparator needs and the production record does not carry.
 *
 * ─── THE MEASUREMENT THIS MODULE EXISTS TO RECORD ───
 *
 * The comparator (`loop-guard.mjs`) classifies a transition from the SET OF FIELD
 * PATHS each attempt was rejected for. `signature.mjs#attemptPaths` reads
 * `attempt.violations[]` or `attempt.paths[]` and returns `null` for anything
 * else — deliberately, because the alternative is regexing `dataExpectations[0].id`
 * out of a sentence, and that is the mechanism this repository died by on
 * 2026-08-04.
 *
 * The production record carries neither. Measured 2026-08-10, the whole chain:
 *
 *   scorer-protocol.ts#collectManifestProblems  →  {field, message, remediation}
 *   spec-validate.ts:1330                       →  blocking("other", null,
 *                                                    `… ${problem.message} :: ${problem.remediation}`)
 *   contracts.ts:308  AuditFinding              =  {criterionId, kind, detail, mustRegenerate}
 *
 * `problem.field` — the one structured field path in the entire pipeline — is
 * DROPPED at the `blocking(...)` call and survives only inside `detail`'s prose.
 * `AuthoringAttempt.findings` therefore carries no path, the thrown
 * `BakeoffError` carries `{code, message, remediation}` and no attempts at all,
 * and `orchestrator.ts` writes `violations: null` because there is genuinely
 * nothing structured to write. So on the production record shape the comparator
 * reports BLIND, and the oscillation that killed run `a913c871` is invisible to
 * it. That is not a bug in the comparator; it is a missing field upstream.
 *
 * ─── WHAT THIS MODULE DOES ABOUT IT ───
 *
 * It derives the paths the honest way: from the manifest DOCUMENT, through the
 * live sealed parser, structurally. `collectManifestProblems` is passed in rather
 * than imported so the caller supplies whatever checker is on disk right now
 * (`tools/replay/checker.mjs#loadChecker`) — a vendored copy would keep agreeing
 * with the validator of the day it was copied, which is a check that can only
 * observe success.
 *
 * It is the derivation the eventual writer needs. It is NOT wired into the
 * production record, because the document is not on disk at defect time: the
 * seat's manifest lives in `spec-agent.ts`'s in-memory `lastManifest` and reaches
 * no artefact on the failure path. Closing that is a one-line change inside
 * `bakeoff/src`, which moves the scorer digest — see the HANDOFF in this round's
 * report.
 */

import { normalisePath } from "./signature.mjs";

/**
 * The normalised, de-duplicated, sorted field paths a manifest document is
 * rejected for. `[]` means the parser accepted it.
 *
 * THE UNATTRIBUTED LABEL IS DROPPED, AND SAYING WHY MATTERS.
 * `collectManifestProblems` labels the parser's own first complaint
 * `suite.manifest.json` when no probe reproduced it — a document-level label, not
 * a field path. Keeping it would put a constant in every attempt's set, and a
 * constant present in every set makes the OSCILLATION and NON_MONOTONE arms
 * unreachable: no two sets could ever be disjoint. It is reported separately by
 * {@link manifestPathReport} instead of being silently discarded.
 *
 * @param {(raw: unknown) => readonly {field: string}[]} collect
 * @param {unknown} document
 * @returns {readonly string[]}
 */
export function manifestFieldPaths(collect, document) {
  return manifestPathReport(collect, document).paths;
}

/**
 * The same derivation, with the two facts a caller must not have to infer:
 * how many problems were surveyed, and how many of them named no field.
 *
 * @param {(raw: unknown) => readonly {field: string}[]} collect
 * @param {unknown} document
 */
export function manifestPathReport(collect, document) {
  const problems = collect(document) ?? [];
  const paths = new Set();
  let unattributed = 0;
  for (const problem of problems) {
    const field = String(problem?.field ?? "").trim();
    // A LABEL WITH NO DOT AND NO SUBSCRIPT IS A DOCUMENT, NOT A FIELD. That is
    // exactly the shape of `suite.manifest.json` and of a raw file path, and it
    // is how the authoritative entry announces that no probe could attribute it.
    if (field === "" || !/[.[]/.test(field.replace(/\.json$/i, ""))) {
      unattributed += 1;
      continue;
    }
    paths.add(normalisePath(field));
  }
  return { paths: [...paths].sort(), problems: problems.length, unattributed };
}

/**
 * A sequence of manifest documents as `DefectRecord.attempts` WOULD look if the
 * field paths travelled — i.e. the input `evaluateAttempts` can actually read.
 *
 * `problems` is kept alongside `violations` on purpose: the production shape has
 * the prose and nothing else, and a reader must be able to see both what is there
 * today and what is missing.
 *
 * @param {(raw: unknown) => readonly {field: string}[]} collect
 * @param {readonly unknown[]} documents  oldest attempt first
 */
export function attemptsFromManifests(collect, documents) {
  return documents.map((document, index) => {
    const report = manifestPathReport(collect, document);
    return {
      n: index + 1,
      at: "",
      problems: report.paths.map((path) => `${path} was refused by the sealed manifest parser`),
      violations: report.paths.map((path) => ({ path, expected: "accepted by parseSuiteManifest", got: "refused" })),
    };
  });
}

/**
 * THE ARM CHECK — the derivation must be able to return NOTHING.
 *
 * A path extractor that reports fields for every document, valid ones included,
 * would make every attempt look violated and every transition classifiable; the
 * comparator built on it would escalate on data that carries no defect at all.
 * So this drives both directions with documents whose answers are known: a
 * manifest the sealed parser ACCEPTS must yield zero paths, and one it refuses
 * must yield some. Collapse the two and it reports BLIND.
 *
 * @param {(raw: unknown) => readonly {field: string}[]} collect
 * @param {{good: unknown, bad: unknown}} documents
 */
export function armCheck(collect, documents) {
  const wrong = [];
  const good = manifestPathReport(collect, documents.good);
  const bad = manifestPathReport(collect, documents.bad);
  if (good.paths.length !== 0) wrong.push(`a manifest the parser accepts yielded ${good.paths.length} path(s)`);
  if (bad.paths.length === 0) wrong.push("a manifest the parser refuses yielded no path at all, so nothing can be compared");
  const lines = [
    `ARM CHECK: manifest path derivation — accepted document -> ${good.paths.length} path(s), ` +
      `refused document -> ${bad.paths.length} path(s) (${bad.unattributed} unattributed problem(s) dropped)`,
    wrong.length === 0
      ? "ARM CHECK: armed — the derivation can return nothing, so a clean attempt cannot look violated"
      : `ARM CHECK: BLIND — ${wrong.join("; ")}. Paths derived from this would make the anti-loop comparator guess.`,
  ];
  return { armed: wrong.length === 0, wrong, lines, good, bad };
}
