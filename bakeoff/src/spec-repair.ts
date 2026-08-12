/**
 * spec-repair.ts — fix the artefact the audit named, instead of discarding the suite.
 *
 * WHAT THIS CHANGES, AND THE FOUR RUNS THAT PAID FOR IT. Until this module the
 * authoring loop had exactly one response to a failed audit: throw the whole
 * candidate suite away and author another one from the ticket, spending one of
 * three attempts. Every spec-phase death in this repository's run history was a
 * suite rejected for a defect in ONE named artefact:
 *
 *   run `ac275880` (2026-08-11)  [other] test file "holdout/motion-and-visuals.spec.mjs"
 *                               contains credential-shaped literal(s): SECRET_ASSIGNMENT x1
 *   run `0629aa6c` (2026-08-10)  [vacuous] test file "holdout/site-routes.test.mjs"
 *                               contains a "not implemented" marker
 *   run `aa6e721e` (2026-08-11)  [mis_specified] REQ-013: statement matches no EARS template
 *   run `a913c871` (2026-08-09)  [other] the suite manifest "suite.manifest.json" is not
 *                               executable by the sealed scorer: dataExpectations[0].id …
 *
 * Four rejections, four named artefacts, and in every case the other twenty-odd
 * criteria and half-dozen files were never examined again. Three attempts times
 * roughly forty minutes each is the measured cost of re-deriving a suite that
 * was, apart from one string, already audited.
 *
 * WHY REPAIR IS SOUND HERE AND IS NOT "THE MODEL GRADING ITSELF". Self-correction
 * without an external verifier is unreliable; with one it is not, and this loop
 * HAS one — `deterministicAudit` and the judge seat both run again, in full, over
 * the spliced draft, exactly as they run over a freshly authored one. Nothing
 * reaches {@link freezeSuite} that has not passed a complete audit. The
 * guarantee `spec-agent.ts` states in its header — *a suite that fails the audit
 * is regenerated, never used* — is preserved verbatim: a repaired suite that
 * fails the re-audit is still discarded.
 *
 * WHY ONLY THE NAMED ARTEFACTS GO BACK, AND NOT THE WHOLE DRAFT. Handing the
 * seat its entire previous suite was considered and rejected on cost — see the
 * numbers in {@link AuthoringRetryContext}'s docblock: the drafts ran 50-64 KB
 * against prompts already carrying an 80 KB document and a 560 KB image. Those
 * numbers still hold, so this module sends back only the artefacts the findings
 * name, and asks for only those artefacts in return. That is also the safer
 * shape for a different reason: run `a913c871`'s attempt 3, asked to write a
 * whole new suite, LOST a manifest field that attempt 2 had already got right.
 * An artefact that is never re-derived cannot be lost.
 *
 * WHAT MAKES A FINDING REPAIRABLE. TWO THINGS, AND THE FIRST WAS ADDED AFTER IT
 * WAS MISSING COST A RUN. The judge must have declared the remedy an `edit` —
 * a defect INSIDE an artefact rather than a missing one; see `AuditFinding.remedy`
 * and run `d143e52d`. And it must name something that exists in the
 * draft — a criterion id, or a test file path. `AuditFinding` carries
 * `criterionId` structurally but has no field for a file, so the path is found
 * by looking for each of THIS DRAFT'S OWN paths inside the finding's detail.
 * That direction matters: the identifiers come from the draft and are matched
 * against the prose, never parsed out of it, so a match cannot invent an
 * artefact that does not exist. A round where any blocking finding names
 * nothing is declined whole — repairing three of four defects buys a second
 * rejection at the price of a call.
 */

import type { AuditFinding, Ticket } from "./contracts.js";
import type { DraftCriterion, DraftTestFile, SuiteDraft } from "./spec-types.js";
import { MAX_CRITERIA } from "./spec-types.js";

/* -------------------------------------------------------------------------
 * 1. What a repair round is asked to fix
 * ---------------------------------------------------------------------- */

/**
 * Repair rounds allowed inside ONE authoring attempt. `0` disables repair and
 * restores the pre-2026-08-12 loop exactly.
 *
 * ONE, NOT THREE, AND THE REASON IS THE SAME ONE THAT BOUNDS THE ATTEMPTS. A
 * seat that could not clear a named defect when handed that exact artefact and
 * that exact complaint is not going to clear it on the third telling; what it
 * does instead is drift, which is what run `a913c871` measured across its three
 * regenerations. A second round would double the worst-case call count of a
 * doomed phase to buy the case where the seat fixed the defect and broke one
 * other thing — a case never yet observed here. Raise it when it is.
 */
export const DEFAULT_MAX_REPAIR_ROUNDS = 1;

/**
 * The artefacts one repair round sends back to the seat, and the complaints
 * that selected them.
 *
 * `criteria` and `files` are the draft's own objects, unmodified. `problems` is
 * {@link blockingFindingSummary}'s rendering of the blocking findings —
 * already redacted, and the same sentences the regeneration path would have
 * accumulated as constraints.
 */
export interface RepairTargets {
  readonly criteria: readonly DraftCriterion[];
  readonly files: readonly DraftTestFile[];
  readonly problems: readonly string[];
  /**
   * Blocking findings this round cannot clear, each tagged with WHY.
   *
   * TWO CLASSES, AND THEY ARE DIFFERENT FACTS ABOUT THE FINDING. `[remedy=add]`
   * means the judge said closing it needs an artefact that does not exist, so no
   * edit to anything can satisfy it. `[unlocalised]` means it named nothing in
   * this draft to hand back. Reporting both as "named no criterion or file"
   * — which this field's consumers did until 2026-08-12 — tells the owner
   * something false about a finding that named five real artefacts.
   *
   * NON-EMPTY MEANS THE ROUND IS DECLINED, and the sentences are kept so the
   * decision can be reported rather than inferred. A caller that silently did
   * nothing here would be indistinguishable from a caller whose repair loop was
   * never wired — the failure mode this repository has caught in itself
   * repeatedly.
   */
  readonly unlocalised: readonly string[];
}

/** An id match that cannot be satisfied by a longer id containing it. */
function mentions(detail: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(detail);
}

/**
 * Which of this draft's artefacts the blocking findings name.
 *
 * ONLY BLOCKING FINDINGS SELECT AN ARTEFACT. An advisory finding does not stop
 * the suite being used, so repairing it would spend a call to change something
 * nobody was waiting on — and, worse, would re-open an artefact the audit had
 * accepted.
 */
export function repairTargets(
  draft: SuiteDraft,
  findings: readonly AuditFinding[],
  problems: readonly string[],
): RepairTargets {
  const criteria = new Map<string, DraftCriterion>();
  const files = new Map<string, DraftTestFile>();
  const unlocalised: string[] = [];

  const blocking = findings.filter((f) => f.mustRegenerate);
  for (let i = 0; i < blocking.length; i += 1) {
    const finding = blocking[i];
    if (finding === undefined) continue;

    /*
     * REMEDY FIRST, LOCALISATION SECOND, AND THE ORDER IS THE CORRECTION.
     *
     * This function used to ask only "does the finding name an artefact that
     * exists?" — and run `d143e52d` (2026-08-12) proved that question is the
     * wrong one. Its blocking finding named REQ-004, REQ-003, REQ-006, T-6 and
     * T-33, all real, and said in the same breath that closing it "requires new
     * criteria and tests, i.e. re-authoring". A finding about something MISSING
     * names the artefacts that fail to cover it. It localised perfectly and was
     * unfixable by construction: a repair may only return artefacts it was
     * given, so it can never add the criterion that is absent. The round could
     * not clear it, the fresh re-audit did not re-raise it, and a suite that
     * gated nothing on persistence was frozen as audited.
     *
     * `remedy !== "edit"` rather than `=== "add"`: absent is the unrepairable
     * case too. See `AuditFinding.remedy`.
     */
    if (finding.remedy !== "edit") {
      unlocalised.push(`[remedy=add] ${problems[i] ?? `[${finding.kind}] ${finding.detail}`}`);
      continue;
    }

    let localised = false;

    for (const criterion of draft.criteria) {
      if (finding.criterionId === criterion.id || mentions(finding.detail, criterion.id)) {
        criteria.set(criterion.id, criterion);
        localised = true;
      }
    }
    for (const file of draft.files) {
      // A path is already a distinctive token; `includes` is enough and does
      // not need the id guard above. The direction is the safeguard: the path
      // comes from the draft, so this can only ever select a file that exists.
      if (finding.detail.includes(file.path)) {
        files.set(file.path, file);
        localised = true;
      }
    }

    if (!localised) {
      unlocalised.push(`[unlocalised] ${problems[i] ?? `[${finding.kind}] ${finding.detail}`}`);
    }
  }

  return {
    // Draft order, not match order: a spliced suite whose criteria come back in
    // the order the findings happened to name them is a different document.
    criteria: draft.criteria.filter((c) => criteria.has(c.id)),
    files: draft.files.filter((f) => files.has(f.path)),
    problems,
    unlocalised,
  };
}

/** True when a repair round is worth dispatching for these targets. */
export function isRepairable(targets: RepairTargets): boolean {
  return (
    targets.unlocalised.length === 0 && (targets.criteria.length > 0 || targets.files.length > 0)
  );
}

/* -------------------------------------------------------------------------
 * 2. The repair prompt
 * ---------------------------------------------------------------------- */

export const REPAIR_SYSTEM_PROMPT = `You are the Spec Architect, correcting ONE defect list in a suite you already wrote.

You are NOT writing a new suite. A suite you authored for this ticket was audited, and all of it was accepted except the artefacts below. Those artefacts are given to you verbatim — they are your own bytes — together with the exact complaints against them.

RETURN ONLY THE ARTEFACTS YOU WERE GIVEN, CORRECTED.

  - Every criterion in your response must be one of the criteria shown to you, keeping its id.
  - Every test file in your response must be one of the files shown to you, keeping its path.
  - Do NOT add a criterion, a test file, or a test that was not shown to you. Anything you add is discarded and the whole repair is rejected.
  - Do NOT return an artefact that was not shown to you. The rest of the suite is already accepted and you cannot see it; a change there would be a change you cannot check.

CHANGE ONLY WHAT THE COMPLAINTS NAME. Everything else about a returned artefact must come back exactly as you were given it. A test id you rename, an evidence reference you drop, or a criterion id you renumber breaks a binding to a part of the suite you are not being shown.

THE SAME RULES STILL APPLY to whatever you write. A criterion is EARS notation, binary, and names executable evidence. A test file contains no skipped, focused, tautological or self-satisfying test, no "not implemented" marker, no process.exit, and no credential-shaped literal. A corrected artefact that trades one blocking defect for another has not been corrected.

If a complaint cannot be satisfied without changing an artefact you were not shown, return the artefacts unchanged. Saying so by leaving them alone is correct and cheap; guessing at the rest of the suite is neither.`;

export const REPAIR_JSON_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["criteria", "testFiles"],
  properties: {
    criteria: {
      type: "array",
      // NO `minItems`, UNLIKE THE AUTHORING SCHEMA. A repair that touches only
      // test files returns an empty criteria array, and a schema that refused
      // it would turn the commonest repair shape — a defect in one file — into
      // a structured-output rejection.
      maxItems: MAX_CRITERIA,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "statement",
          "tier",
          "evidenceRequired",
          "holdoutTestIds",
          "visibleTestIds",
          "evidenceArtifacts",
        ],
        properties: {
          id: { type: "string" },
          statement: { type: "string" },
          tier: { type: "string", enum: ["BLOCKING", "FUNCTIONAL", "QUALITY"] },
          evidenceRequired: { type: "string" },
          holdoutTestIds: { type: "array", items: { type: "string" } },
          visibleTestIds: { type: "array", items: { type: "string" } },
          evidenceArtifacts: { type: "array", items: { type: "string" } },
        },
      },
    },
    testFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "visibility", "runner", "description", "testIds", "criterionIds", "source"],
        properties: {
          path: { type: "string" },
          visibility: { type: "string", enum: ["holdout", "visible"] },
          runner: { type: "string", enum: ["node-test", "playwright"] },
          description: { type: "string" },
          testIds: { type: "array", items: { type: "string" } },
          criterionIds: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
      },
    },
  },
});

export const TURN_MARKER_REPAIR = "TURN 2 OF 2 — THE ARTEFACTS TO CORRECT, AND WHAT IS WRONG WITH THEM";

/**
 * The repair turn: the named artefacts verbatim, then the complaints.
 *
 * ARTEFACTS BEFORE COMPLAINTS, deliberately, and for the reason
 * {@link TURN_MARKER_PRIOR} gives about ordering: a complaint read before the
 * document it is about is a complaint about a document the reader is
 * reconstructing from memory.
 */
export function renderRepairTurn(targets: RepairTargets, ticket: Ticket): string {
  const lines: string[] = [
    TURN_MARKER_REPAIR,
    "",
    `These are YOUR OWN artefacts from the suite you wrote for ticket ${ticket.id}. Nobody else ` +
      "wrote any of them. Every other part of that suite passed the audit and is being kept exactly " +
      "as you wrote it — you are not being shown it because you are not changing it.",
    "",
  ];

  if (targets.criteria.length > 0) {
    lines.push("## CRITERIA TO CORRECT");
    lines.push("");
    for (const criterion of targets.criteria) {
      lines.push(`${criterion.id} [${criterion.tier}]`);
      lines.push(`  statement: ${criterion.statement}`);
      lines.push(`  evidenceRequired: ${criterion.evidenceRequired}`);
      lines.push(`  holdoutTestIds: ${criterion.holdoutTestIds.join(", ") || "(none)"}`);
      lines.push(`  visibleTestIds: ${criterion.visibleTestIds.join(", ") || "(none)"}`);
      lines.push(`  evidenceArtifacts: ${criterion.evidenceArtifacts.join("; ") || "(none)"}`);
      lines.push("");
    }
  }

  if (targets.files.length > 0) {
    lines.push("## TEST FILES TO CORRECT");
    lines.push("");
    for (const file of targets.files) {
      lines.push(
        `### ${file.path}  [${file.visibility}, ${file.runner}, tests ${file.expectedTestIds.join(", ") || "(none declared)"}, criteria ${file.criterionIds.join(", ") || "(none)"}]`,
      );
      lines.push(`description: ${file.description}`);
      lines.push("```javascript");
      lines.push(file.source);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## WHAT THE AUDIT SAID");
  lines.push("");
  lines.push(
    "Every sentence below is BLOCKING: the suite cannot be used while any of them is still true.",
  );
  lines.push("");
  for (let i = 0; i < targets.problems.length; i += 1) {
    lines.push(`  ${String(i + 1)}. ${targets.problems[i] ?? ""}`);
  }
  lines.push("");
  lines.push(
    "Return the artefacts above, corrected. Return nothing else. An artefact you were not shown " +
      "cannot be returned, and an artefact you were shown and did not need to change may be " +
      "returned exactly as it is or left out entirely — both mean the same thing.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------
 * 3. Reading the repair back, and splicing it in
 * ---------------------------------------------------------------------- */

export type RepairParseResult =
  | { readonly ok: true; readonly draft: SuiteDraft }
  | { readonly ok: false; readonly problems: readonly string[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/**
 * Read a repair response and splice it over the draft.
 *
 * EVERY REJECTION HERE IS A REFUSAL TO WIDEN THE REPAIR'S BLAST RADIUS. The
 * audit accepted the rest of this suite; a response that renames a criterion,
 * introduces a file, or answers with an artefact nobody asked about is not a
 * correction of the audited document, and splicing it would mean freezing a
 * suite no audit ever saw in that shape. The re-audit downstream would probably
 * catch it — "probably" is the reason this does not rely on it.
 *
 * A response that returns FEWER artefacts than were sent is accepted: the
 * system prompt tells the seat that an artefact it did not need to change may
 * be left out, and the re-audit decides whether the omission was justified. A
 * response that returns NONE is rejected, because a repair that changed nothing
 * cannot clear a blocking finding and the re-audit would spend a judge call
 * proving it.
 */
export function parseRepairResponse(
  raw: unknown,
  draft: SuiteDraft,
  targets: RepairTargets,
): RepairParseResult {
  const root = asRecord(raw);
  if (root === null) return { ok: false, problems: ["the repair response was not a JSON object"] };

  const rawCriteria: unknown = root["criteria"];
  const rawFiles: unknown = root["testFiles"];
  if (!Array.isArray(rawCriteria)) {
    return { ok: false, problems: ["repair.criteria: expected an array"] };
  }
  if (!Array.isArray(rawFiles)) {
    return { ok: false, problems: ["repair.testFiles: expected an array"] };
  }

  const problems: string[] = [];
  const allowedCriteria = new Map(targets.criteria.map((c) => [c.id, c]));
  const allowedFiles = new Map(targets.files.map((f) => [f.path, f]));

  const repairedCriteria = new Map<string, DraftCriterion>();
  for (let i = 0; i < rawCriteria.length; i += 1) {
    const where = `repair.criteria[${String(i)}]`;
    const item = asRecord(rawCriteria[i]);
    if (item === null) {
      problems.push(`${where}: expected an object`);
      continue;
    }
    const id = item["id"];
    if (typeof id !== "string" || !allowedCriteria.has(id)) {
      problems.push(
        `${where}.id: ${typeof id === "string" ? `"${id}"` : "(missing)"} was not one of the ` +
          `criteria sent for repair (${targets.criteria.map((c) => c.id).join(", ") || "none"})`,
      );
      continue;
    }
    const statement = item["statement"];
    const evidenceRequired = item["evidenceRequired"];
    const tier = item["tier"];
    const holdoutTestIds = asStringArray(item["holdoutTestIds"]);
    const visibleTestIds = asStringArray(item["visibleTestIds"]);
    const evidenceArtifacts = asStringArray(item["evidenceArtifacts"] ?? []);
    if (
      typeof statement !== "string" ||
      typeof evidenceRequired !== "string" ||
      (tier !== "BLOCKING" && tier !== "FUNCTIONAL" && tier !== "QUALITY") ||
      holdoutTestIds === null ||
      visibleTestIds === null ||
      evidenceArtifacts === null
    ) {
      problems.push(`${where}: a corrected criterion must carry every field it was given`);
      continue;
    }
    repairedCriteria.set(id, {
      id,
      statement,
      evidenceRequired,
      tier,
      holdoutTestIds,
      visibleTestIds,
      evidenceArtifacts,
    });
  }

  const repairedFiles = new Map<string, DraftTestFile>();
  for (let i = 0; i < rawFiles.length; i += 1) {
    const where = `repair.testFiles[${String(i)}]`;
    const item = asRecord(rawFiles[i]);
    if (item === null) {
      problems.push(`${where}: expected an object`);
      continue;
    }
    const path = item["path"];
    if (typeof path !== "string" || !allowedFiles.has(path)) {
      problems.push(
        `${where}.path: ${typeof path === "string" ? `"${path}"` : "(missing)"} was not one of the ` +
          `files sent for repair (${targets.files.map((f) => f.path).join(", ") || "none"})`,
      );
      continue;
    }
    const visibility = item["visibility"];
    const runner = item["runner"];
    const description = item["description"];
    const source = item["source"];
    const expectedTestIds = asStringArray(item["testIds"]);
    const criterionIds = asStringArray(item["criterionIds"]);
    if (
      (visibility !== "holdout" && visibility !== "visible") ||
      (runner !== "node-test" && runner !== "playwright") ||
      typeof description !== "string" ||
      typeof source !== "string" ||
      expectedTestIds === null ||
      criterionIds === null
    ) {
      problems.push(`${where}: a corrected test file must carry every field it was given`);
      continue;
    }
    repairedFiles.set(path, { path, visibility, runner, description, expectedTestIds, criterionIds, source });
  }

  if (problems.length > 0) return { ok: false, problems };
  if (repairedCriteria.size === 0 && repairedFiles.size === 0) {
    return {
      ok: false,
      problems: ["the repair response returned no artefact at all, so nothing was corrected"],
    };
  }

  /*
   * AT LEAST ONE ARTEFACT MUST ACTUALLY DIFFER.
   *
   * A response echoing back exactly what it was sent satisfies every rule above:
   * the ids are known, the fields are present, the count is non-zero. Nothing
   * was corrected, but the spliced draft is byte-identical to the audited one
   * and goes to a FRESH judge with no memory of the first — which is precisely
   * how run `d143e52d`'s blocking finding stopped being raised. A no-op repair
   * is therefore not a wasted call; it is a coin flip on whether a real defect
   * survives, paid for at the price of a judge call.
   *
   * ONE, NOT ALL: the seat is told it may return an artefact it did not need to
   * change, and a round that fixes one of three files legitimately sends two
   * back untouched. Requiring every artefact to differ would refuse that.
   */
  const unchanged = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const anyChanged =
    [...repairedCriteria.values()].some((c) => !unchanged(c, allowedCriteria.get(c.id))) ||
    [...repairedFiles.values()].some((f) => !unchanged(f, allowedFiles.get(f.path)));
  if (!anyChanged) {
    return {
      ok: false,
      problems: [
        "the repair response returned every artefact exactly as it was sent, so the suite that would " +
          "be re-audited is the one the audit already rejected",
      ],
    };
  }

  return {
    ok: true,
    draft: {
      ticketId: draft.ticketId,
      ticketSha256: draft.ticketSha256,
      // IN PLACE, BY IDENTITY. The criteria and files a repair did not touch
      // keep their objects and their positions; nothing is appended and nothing
      // is reordered, so a suite that comes back from repair differs from the
      // audited one at exactly the artefacts the findings named.
      criteria: draft.criteria.map((c) => repairedCriteria.get(c.id) ?? c),
      files: draft.files.map((f) => repairedFiles.get(f.path) ?? f),
    },
  };
}
