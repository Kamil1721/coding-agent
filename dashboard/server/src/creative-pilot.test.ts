import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ticket } from "bakeoff/dist/contracts.js";

import { compileCreativeContract } from "./creative-contract.js";
import type { CreativeContractV1 } from "./creative-contract.js";
import type { CreativeContractAuthorResult } from "./creative-contract-author.js";
import {
  CREATIVE_AUTHOR_FILE,
  CREATIVE_ARTIFACT_REPAIR_FILE,
  CREATIVE_ARTIFACT_REPAIR_PROMPT_FILE,
  CREATIVE_COMPILE_FILE,
  CREATIVE_CONTRACT_FILE,
  CREATIVE_PILOT_PROJECT_ID,
  authorInputFor,
  claimCreativeArtifactRepair,
  claimCreativeDecision,
  creativeArtifactRevisionPrompt,
  creativeAuthorAttemptFile,
  creativeAuthorAttemptTextFile,
  creativeContractPrompt,
  creativePilotEnabled,
  freshCreativeContract,
  initialCreativePilotStatus,
  persistCreativeAuthorAttempt,
  persistCreativeAuthorResult,
  pilotMayPublish,
  readCreativePilotStatus,
  statusAfterCompile,
  statusAfterReview,
  statusBeforeCreativeMutation,
  webCreativeApplicable,
  writeCreativePilotStatus,
} from "./creative-pilot.js";

const HASH = "a".repeat(64);
const TICKET: Ticket = { id: "ticket-web", title: "Web", brief: "Build a responsive portfolio website for a photographer.", sha256: HASH, tier: "medium" };

function validContract(input = authorInputFor(TICKET, null)): CreativeContractV1 {
  const evidence = input.input.ticket.facts[0]?.evidence;
  assert.ok(evidence);
  const sections: CreativeContractV1["sections"] = [
    {
      id: "hero", routeId: "home", order: 0, kind: "hero", job: "Introduce the photographer and selected work.",
      contentRefs: [{ proofId: "proof", use: "headline" }], eyebrow: null, headline: "Photographs shaped by patient observation",
      body: "Selected editorial and portrait work for thoughtful commissions.",
      actions: [{ id: "work", label: "View work", intent: "portfolio", priority: "primary", href: "/work", proofId: null }],
      layoutFamily: "asymmetric_split", visualKind: "brand_asset",
      mobile: { strategy: "stack", contentOrder: ["headline", "body", "visual", "actions"] }, requiredStates: ["default", "interaction"],
    },
    {
      id: "proof", routeId: "home", order: 1, kind: "gallery", job: "Show a concise body of commissioned work.",
      contentRefs: [{ proofId: "proof", use: "headline" }], eyebrow: null, headline: "Selected commissions", body: null, actions: [],
      layoutFamily: "gallery_grid", visualKind: "brand_asset",
      mobile: { strategy: "stack", contentOrder: ["headline", "visual"] }, requiredStates: ["default"],
    },
    {
      id: "footer", routeId: "home", order: 2, kind: "footer", job: "Close with a direct route to contact.",
      contentRefs: [{ proofId: "proof", use: "headline" }], eyebrow: null, headline: "Available for selected commissions", body: null, actions: [],
      layoutFamily: "footer_columns", visualKind: "none",
      mobile: { strategy: "preserve", contentOrder: ["headline"] }, requiredStates: ["default"],
    },
  ];
  return {
    schemaVersion: 1,
    contractId: input.input.contractId,
    designRead: {
      pageKind: "portfolio", audience: "Editors and clients seeking a photographer.", vibe: "Quiet, precise and image-led.",
      aestheticFamily: "editorial", designSystem: "native", displayStyle: "serif", paletteFamily: "custom", theme: "light",
      thesis: "Let the owner's photography lead while typography gives each commission a clear narrative frame.",
    },
    dials: { designVariance: 6, motionIntensity: 3, visualDensity: 4 },
    contentProof: [{ id: "proof", claim: "The owner requested a photographer portfolio.", status: "owner_required", evidence, allowedUses: ["headline"] }],
    routes: [{ id: "home", path: "/", sectionIds: ["hero", "proof", "footer"] }],
    sections,
    motion: [],
    intentionalExceptions: [],
  };
}

test("creative pilot is exact-project default-off and WEB-only", () => {
  assert.equal(CREATIVE_PILOT_PROJECT_ID, "coding-agent");
  assert.equal(creativePilotEnabled("repo", undefined), false);
  assert.equal(creativePilotEnabled("repo", "other"), false);
  assert.equal(creativePilotEnabled("repo", "repo"), true);
  assert.equal(webCreativeApplicable("web-ui"), true);
  assert.equal(webCreativeApplicable("fullstack"), true);
  assert.equal(webCreativeApplicable("api"), false);
});

test("production boot wires the exact pilot identity against the independently derived actual project", () => {
  const index = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.match(index, /creativePilotProjectId: CREATIVE_PILOT_PROJECT_ID,/u);
  assert.match(index, /creativePilotActualProjectId: dashboardProjectId\(env\),/u);
});

test("host author packet admits bounded ticket/design facts and digest-only references", () => {
  const packet = authorInputFor(TICKET, {
    images: [{ path: "/private/reference.png", sha256: "b".repeat(64), bytes: 12 }],
    capture: null,
    documents: [],
    motion: null,
  });
  assert.equal(packet.input.ticket.facts.length, 1);
  assert.equal(packet.input.designFacts.length, 1);
  assert.equal(packet.input.referenceFacts.length, 1);
  assert.equal(JSON.stringify(packet.input).includes("/private/"), false);
  for (const fact of [...packet.input.ticket.facts, ...packet.input.designFacts, ...packet.input.referenceFacts]) {
    assert.deepEqual(packet.resolver.resolve(fact.evidence), {
      sha256: fact.evidence.sha256,
      excerptSha256: fact.evidence.excerptSha256,
    });
  }
});

test("host author packet preserves late plan answers plus captured page and motion facts beyond 500 characters", () => {
  const lateAnswer = "Use a warm editorial canvas and keep the readiness summary visible beside the contact state.";
  const amended: Ticket = {
    ...TICKET,
    brief: [
      "Build the requested browser experience. ".repeat(40),
      "--- WHAT THE DASHBOARD ASKED BEFORE ANY CRITERIA WERE WRITTEN ---",
      "",
      `PQ-1 — asked: \"Which visual direction should lead?\" [ANSWERED BY THE OWNER]`,
      `  he answered: \"${lateAnswer}\"`,
      "",
      "--- END OF THE PLANNING EXCHANGE ---",
    ].join("\n"),
  };
  const packet = authorInputFor(amended, {
    images: [],
    documents: [],
    capture: {
      url: "https://example.com/",
      capturedAt: "2026-08-21T00:00:00.000Z",
      shots: [],
      outline: {
        url: "https://example.com/",
        title: "Reference consultancy",
        headings: [{ level: 2, text: "GLOBO production proof" }],
        links: ["Run the readiness check"],
        palette: ["#f5f2ec", "#202020"],
      },
    },
    motion: {
      url: "https://example.com/",
      capturedAt: "2026-08-21T00:00:00.000Z",
      entries: [{
        family: "scroll-reveal",
        role: "section.proof",
        props: ["opacity", "transform"],
        durationMs: 700,
        staggerMs: 0,
        easing: "ease-out",
        iterations: 1,
        scrollRatio: null,
        parity: true,
      }],
      libraries: ["motion"],
      respectsReducedMotion: true,
    },
  });
  const serialized = JSON.stringify(packet.input);
  assert.match(serialized, new RegExp(lateAnswer, "u"));
  assert.match(serialized, /GLOBO production proof/u);
  assert.match(serialized, /scroll-reveal/u);
  assert.ok(packet.input.ticket.facts.length > 1, "the owner brief must be projected as bounded facts, not one truncated fact");
  assert.ok(packet.input.ticket.facts.every((fact) => fact.statement.length <= 500));
  assert.ok(packet.input.referenceFacts.every((fact) => fact.statement.length <= 500));
  assert.ok(packet.input.ticket.facts.length <= 40);
  assert.ok(packet.input.referenceFacts.length <= 20);
});

test("owner projection preserves the bounded head and tail with an admitted omission notice", () => {
  const tailConstraint = "TAIL-CONSTRAINT: keep the readiness result beside the final contact action.";
  const long: Ticket = {
    ...TICKET,
    brief: `${Array.from({ length: 260 }, (_, index) => `Owner requirement ${String(index)} must remain concrete and testable.`).join(" ")} ${tailConstraint}`,
  };
  const packet = authorInputFor(long, null);
  const statements = packet.input.ticket.facts.map((fact) => fact.statement);
  assert.equal(statements.length, 18);
  assert.match(statements[0] ?? "", /Owner requirement 0/u);
  assert.match(statements.join("\n"), /projection notice/u);
  assert.match(statements.at(-1) ?? "", new RegExp(tailConstraint, "u"));
  assert.ok(statements.every((statement) => statement.length <= 500));
});

test("partial historical capture and motion subtrees are narrowed without throwing", () => {
  const partialManifest = {
    images: [],
    documents: [],
    capture: {
      url: "https://example.com/",
      outline: {
        title: "Historical capture",
        headings: [{ level: 2, text: "Preserved historical heading" }, null],
        links: "not-an-array",
        palette: ["#202020"],
      },
    },
    motion: {
      url: "https://example.com/",
      libraries: ["motion"],
      respectsReducedMotion: true,
      entries: [
        {
          family: "scroll-reveal", role: "section.proof", props: ["opacity"], durationMs: 600,
          staggerMs: null, easing: null, iterations: 1, scrollRatio: null, parity: true,
        },
        { family: "historical-entry-with-missing-fields" },
      ],
    },
  } as unknown as NonNullable<Parameters<typeof authorInputFor>[1]>;

  const packet = authorInputFor(TICKET, partialManifest);
  const facts = JSON.stringify(packet.input.referenceFacts);
  assert.match(facts, /Preserved historical heading/u);
  assert.match(facts, /scroll-reveal/u);
  assert.deepEqual(packet.warnings, [
    "Creative author reference warning [capture-partial]: malformed optional capture fields or entries were skipped",
    "Creative author reference warning [motion-partial]: malformed optional motion fields or entries were skipped",
  ]);
  assert.ok(packet.warnings.every((warning) => warning.length <= 300));
});

test("compiled author result is atomically durable and freshness compilation fails closed after tampering", () => {
  const results = mkdtempSync(join(tmpdir(), "creative-pilot-"));
  const input = authorInputFor(TICKET, null);
  const contract = validContract(input);
  const compiled = compileCreativeContract(JSON.stringify(contract), input.resolver);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const repairs = [{
    code: "CONTENT_USE_NOT_ALLOWED",
    path: "/sections/0/actions/0/proofId",
    action: "null_unauthorized_action_proof_id",
    before: "proof",
  }] as const;
  const result: CreativeContractAuthorResult = {
    schemaVersion: 1, status: "compiled", ran: true, inputHash: HASH, promptHash: HASH,
    contractHash: compiled.contractHash, contract: compiled.contract, errors: [], compileErrors: [], repairs, detail: "ok",
    tokens: null, rateLimit: null, authorBy: "test",
  };
  const compile = persistCreativeAuthorResult(results, result);
  assert.equal(compile.outcome, "passed");
  assert.equal(existsSync(join(results, CREATIVE_AUTHOR_FILE)), true);
  assert.deepEqual(
    (JSON.parse(readFileSync(join(results, CREATIVE_AUTHOR_FILE), "utf8")) as CreativeContractAuthorResult).repairs,
    repairs,
  );
  assert.equal(existsSync(join(results, CREATIVE_CONTRACT_FILE)), true);
  assert.equal(existsSync(join(results, CREATIVE_COMPILE_FILE)), true);
  assert.equal(freshCreativeContract(results, input.resolver).fresh?.contractHash, compiled.contractHash);

  const tampered = { ...contract, contractId: "different-contract" };
  writeFileSync(join(results, CREATIVE_CONTRACT_FILE), JSON.stringify(tampered), "utf8");
  const stale = freshCreativeContract(results, input.resolver);
  assert.equal(stale.fresh, null);
  assert.equal(stale.compile.outcome, "failed");
  assert.match(stale.compile.findings[0]?.message ?? "", /frozen authored contract/u);
  assert.notEqual(readFileSync(join(results, CREATIVE_COMPILE_FILE), "utf8"), "");
});

/**
 * Per-attempt author files (2026-08-25, run run-2026-08-25T10-30-39-122Z-d728ab79:
 * one author record on disk, nothing to show what a second attempt was told).
 * They sit beside the canonical record and never decide freshness, in BOTH
 * directions: an invalid attempt file next to a compiled canonical record is
 * still fresh, and a compiled attempt file next to an invalid canonical record
 * is not.
 */
test("per-attempt author files are durable beside the canonical record and never decide freshness — both directions", () => {
  const input = authorInputFor(TICKET, null);
  const contract = validContract(input);
  const compiled = compileCreativeContract(JSON.stringify(contract), input.resolver);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const compiledResult: CreativeContractAuthorResult = {
    schemaVersion: 1, status: "compiled", ran: true, inputHash: HASH, promptHash: HASH,
    contractHash: compiled.contractHash, contract: compiled.contract, errors: [], compileErrors: [], repairs: [],
    detail: "creative contract compiled", tokens: null, rateLimit: null, authorBy: "test",
  };
  const invalidResult: CreativeContractAuthorResult = {
    schemaVersion: 1, status: "invalid", ran: true, inputHash: HASH, promptHash: "b".repeat(64),
    contractHash: null, contract: null,
    errors: [{ code: "COMPILE_REJECTED", path: "/", message: "author output failed the CreativeContractV1 compiler" }],
    compileErrors: [{ code: "MOTION_FALLBACK_INVALID", path: "/motion/1/trigger", message: "interaction motion requires an interaction render state on its section" }],
    repairs: [], detail: "creative author output did not compile", tokens: null, rateLimit: null, authorBy: "test",
  };
  assert.equal(creativeAuthorAttemptFile(3), "creative-contract-author-attempt-3.json");

  // Direction 1: compiled canonical record, invalid attempt-2 file beside it → fresh.
  const fresh = mkdtempSync(join(tmpdir(), "creative-pilot-attempt-"));
  persistCreativeAuthorResult(fresh, compiledResult);
  persistCreativeAuthorAttempt(fresh, 2, invalidResult);
  const attemptPath = join(fresh, creativeAuthorAttemptFile(2));
  assert.equal(existsSync(attemptPath), true);
  assert.equal((JSON.parse(readFileSync(attemptPath, "utf8")) as CreativeContractAuthorResult).status, "invalid");
  assert.equal(readdirSync(fresh).filter((name) => name.endsWith(".tmp")).length, 0, "the atomic write leaves no temporary file");
  assert.equal((JSON.parse(readFileSync(join(fresh, CREATIVE_AUTHOR_FILE), "utf8")) as CreativeContractAuthorResult).status, "compiled", "the canonical record is untouched");
  assert.equal(freshCreativeContract(fresh, input.resolver).fresh?.contractHash, compiled.contractHash, "an attempt file does not stale a compiled canonical record");

  // Direction 2 (THE CONTROL): invalid canonical record, compiled attempt-1 file beside it → NOT fresh,
  // and the attempt writer never produced a contract file.
  const stale = mkdtempSync(join(tmpdir(), "creative-pilot-attempt-"));
  persistCreativeAuthorResult(stale, invalidResult);
  persistCreativeAuthorAttempt(stale, 1, compiledResult);
  assert.equal(existsSync(join(stale, creativeAuthorAttemptFile(1))), true);
  assert.equal(existsSync(join(stale, CREATIVE_CONTRACT_FILE)), false, "an attempt file never writes the contract");
  const checked = freshCreativeContract(stale, input.resolver);
  assert.equal(checked.fresh, null, "a compiled attempt file does not make an invalid canonical record fresh");
  assert.equal(checked.compile.outcome, "unavailable");
});

/**
 * The model's output text lives in a `.txt` beside the attempt JSON, never
 * inside it (2026-08-25, run run-2026-08-25T10-30-39-122Z-d728ab79: three
 * rejected attempts and no record of what was written). Both directions: a
 * non-empty `rawText` produces the `.txt` and a JSON without the key; a null
 * one produces no `.txt` and removes a stale one for the same attempt number.
 */
test("persistCreativeAuthorAttempt writes the output text beside the JSON and never inside it — both directions", () => {
  const token = ["ghp", "AbCdEfGh0123456789JkLmNo"].join("_");
  const rawText = `{"schemaVersion":1,"note":"${token}","pad":"${"x".repeat(4_000)}"}`;
  const invalidResult: CreativeContractAuthorResult = {
    schemaVersion: 1, status: "invalid", ran: true, inputHash: HASH, promptHash: "b".repeat(64),
    contractHash: null, contract: null,
    errors: [{ code: "COMPILE_REJECTED", path: "/", message: "author output failed the CreativeContractV1 compiler" }],
    compileErrors: [{ code: "UNKNOWN_KEY", path: "/note", message: "key is outside the closed schema" }],
    repairs: [], detail: "creative author output did not compile", tokens: null, rateLimit: null, authorBy: "test",
    rawText,
  };
  assert.equal(creativeAuthorAttemptTextFile(3), "creative-contract-author-attempt-3.txt");

  const results = mkdtempSync(join(tmpdir(), "creative-pilot-raw-"));
  persistCreativeAuthorAttempt(results, 1, invalidResult);
  const record = JSON.parse(readFileSync(join(results, creativeAuthorAttemptFile(1)), "utf8")) as Record<string, unknown>;
  assert.equal("rawText" in record, false, "the JSON record never carries the output text");
  assert.equal(record["status"], "invalid");
  assert.deepEqual(record["compileErrors"], invalidResult.compileErrors);
  const textPath = join(results, creativeAuthorAttemptTextFile(1));
  assert.equal(existsSync(textPath), true, "the .txt sits beside the JSON");
  const text = readFileSync(textPath, "utf8");
  assert.ok(text.startsWith("{\"schemaVersion\":1,\"note\":\""), text.slice(0, 60));
  assert.ok(!text.includes(token), "the credential never reaches disk");
  assert.ok(text.includes("[REDACTED:"), text.slice(0, 120));
  assert.equal(readdirSync(results).filter((name) => name.endsWith(".tmp")).length, 0, "both writes are atomic");
  assert.equal(existsSync(join(results, CREATIVE_CONTRACT_FILE)), false, "an attempt file never writes the contract");

  // THE CONTROL: rawText null → no .txt for that attempt; and a same-numbered re-run without output removes the stale one.
  persistCreativeAuthorAttempt(results, 2, { ...invalidResult, rawText: null });
  assert.equal(existsSync(join(results, creativeAuthorAttemptFile(2))), true);
  assert.equal(existsSync(join(results, creativeAuthorAttemptTextFile(2))), false, "null output writes no .txt");
  persistCreativeAuthorAttempt(results, 3, { ...invalidResult, rawText: "" });
  assert.equal(existsSync(join(results, creativeAuthorAttemptTextFile(3))), false, "empty output writes no .txt");
  persistCreativeAuthorAttempt(results, 1, { ...invalidResult, rawText: null });
  assert.equal(existsSync(textPath), false, "a resumed entry's attempt 1 without output leaves no stale text from the previous entry");
  assert.equal(readdirSync(results).filter((name) => name.endsWith(".txt")).length, 0);

  // The canonical record is written without the key too — it is read by every freshness check and the UI.
  persistCreativeAuthorResult(results, invalidResult);
  const canonical = JSON.parse(readFileSync(join(results, CREATIVE_AUTHOR_FILE), "utf8")) as Record<string, unknown>;
  assert.equal("rawText" in canonical, false);
  assert.equal(canonical["status"], "invalid");
});

test("builder projection binds the hash and all host capture markers", () => {
  const input = authorInputFor(TICKET, null);
  const compiled = compileCreativeContract(JSON.stringify(validContract(input)), input.resolver);
  assert.equal(compiled.ok, true);
  const prompt = creativeContractPrompt({ contract: compiled.contract, contractHash: compiled.contractHash });
  assert.match(prompt, new RegExp(compiled.contractHash, "u"));
  assert.match(prompt, /data-creative-route/u);
  assert.match(prompt, /data-creative-section/u);
  assert.match(prompt, /data-motion-id/u);
  assert.match(prompt, /data-creative-state/u);
  assert.match(prompt, /pixels distinct from default/u);
  assert.match(prompt, /hovers the contracted primary action/u);
  assert.match(prompt, /interaction MUST produce pixels visibly distinct from default/u);
});

test("artifact repair prompt is bounded, critic-free, and durably one-shot", () => {
  const input = authorInputFor(TICKET, null);
  const compiled = compileCreativeContract(JSON.stringify(validContract(input)), input.resolver);
  assert.equal(compiled.ok, true);
  const fresh = { contract: compiled.contract, contractHash: compiled.contractHash };
  const refusal = {
    ok: false as const,
    reason: `section hero is missing ${"x".repeat(4_000)}`,
    issues: [{
      code: "SECTION_NOT_FOUND" as const,
      severity: "blocking" as const,
      profileId: "desktop" as const,
      routeId: "home",
      sectionId: "hero",
      motionId: null,
      evidenceSha256: HASH,
    }],
  };
  const prompt = creativeArtifactRevisionPrompt(fresh, refusal);
  assert.match(prompt, /^CREATIVE ARTIFACT REPAIR BOUNDARY/u);
  assert.match(prompt, /same builder session/i);
  assert.match(prompt, /Do not invent critic findings/u);
  assert.ok(prompt.length < 20_000, "untrusted renderer text must stay bounded");

  const outputDir = mkdtempSync(join(tmpdir(), "creative-artifact-repair-"));
  const first = claimCreativeArtifactRepair(
    outputDir,
    { contractHash: compiled.contractHash, artifactHash: HASH },
    0,
    refusal,
    prompt,
    () => new Date("2026-08-27T10:00:00.000Z"),
  );
  assert.equal(first.kind, "created");
  assert.equal(existsSync(join(outputDir, CREATIVE_ARTIFACT_REPAIR_FILE)), true);
  assert.equal(readFileSync(join(outputDir, CREATIVE_ARTIFACT_REPAIR_PROMPT_FILE), "utf8"), prompt);
  const persisted = readFileSync(join(outputDir, CREATIVE_ARTIFACT_REPAIR_FILE), "utf8");

  const restart = claimCreativeArtifactRepair(
    outputDir,
    { contractHash: compiled.contractHash, artifactHash: "b".repeat(64) },
    0,
    { ...refusal, reason: "a different refusal after restart" },
    "a different prompt",
  );
  assert.equal(restart.kind, "already_claimed");
  assert.equal(readFileSync(join(outputDir, CREATIVE_ARTIFACT_REPAIR_FILE), "utf8"), persisted);
  assert.equal(readFileSync(join(outputDir, CREATIVE_ARTIFACT_REPAIR_PROMPT_FILE), "utf8"), prompt);
});

test("artifact repair claim fails closed when prompt publication is interrupted", () => {
  const input = authorInputFor(TICKET, null);
  const compiled = compileCreativeContract(JSON.stringify(validContract(input)), input.resolver);
  assert.equal(compiled.ok, true);
  const fresh = { contract: compiled.contract, contractHash: compiled.contractHash };
  const refusal = {
    ok: false as const,
    reason: "section hero is missing its contracted marker",
    issues: [{
      code: "SECTION_NOT_FOUND" as const,
      severity: "blocking" as const,
      profileId: "desktop" as const,
      routeId: "home",
      sectionId: "hero",
      motionId: null,
      evidenceSha256: HASH,
    }],
  };
  const prompt = creativeArtifactRevisionPrompt(fresh, refusal);
  const outputDir = mkdtempSync(join(tmpdir(), "creative-artifact-repair-crash-"));
  writeFileSync(join(outputDir, CREATIVE_ARTIFACT_REPAIR_PROMPT_FILE), "simulated interrupted publication\n", "utf8");
  assert.throws(() => claimCreativeArtifactRepair(
    outputDir,
    { contractHash: compiled.contractHash, artifactHash: HASH },
    0,
    refusal,
    prompt,
  ));
  assert.equal(existsSync(join(outputDir, CREATIVE_ARTIFACT_REPAIR_FILE)), true, "the durable claim survives the prompt write failure");
  assert.equal(
    claimCreativeArtifactRepair(outputDir, { contractHash: compiled.contractHash, artifactHash: HASH }, 0, refusal, prompt).kind,
    "already_claimed",
    "a restart cannot spend a second repair after the interrupted publication",
  );
});

test("publication remains closed until all four independent authorities approve", () => {
  const results = mkdtempSync(join(tmpdir(), "creative-status-"));
  const base = initialCreativePilotStatus(true, true);
  const compiled = statusAfterCompile(base, { outcome: "passed", contractHash: HASH, findings: [], checkedAt: new Date().toISOString() });
  writeCreativePilotStatus(results, compiled);
  assert.equal(readCreativePilotStatus(results)?.contractHash, HASH);
  assert.equal(pilotMayPublish(compiled), false);
  const ready = {
    ...compiled,
    heldOutPass: true,
    renderFresh: true,
    criticDisposition: "accept" as const,
    reviewState: "creative_ready" as const,
    ownerDecision: "approved" as const,
  };
  assert.equal(pilotMayPublish(ready), true);
  assert.equal(pilotMayPublish({ ...ready, renderFresh: false }), false);
  assert.equal(pilotMayPublish({ ...ready, renderFresh: null }), false);
  assert.equal(pilotMayPublish({ ...ready, heldOutPass: false }), false);
  assert.equal(pilotMayPublish({ ...ready, ownerDecision: null }), false);
  assert.equal(pilotMayPublish({
    ...ready,
    criticDisposition: "revise",
    ownerDecision: "waived",
    ownerDecisionReason: "The asymmetry is intentional for the supplied editorial reference.",
  }), true);
  assert.equal(pilotMayPublish({ ...ready, criticDisposition: "revise", ownerDecision: "waived", ownerDecisionReason: null }), false);
});

test("review re-entry preserves prior critic evidence and marks it stale before mutation", () => {
  const seeded = {
    ...statusAfterCompile(initialCreativePilotStatus(true, true), {
      outcome: "passed" as const, contractHash: HASH, findings: [], checkedAt: new Date().toISOString(),
    }),
    renderManifestHash: "b".repeat(64),
    renderFresh: true,
    renderProfiles: [
      { profileId: "desktop" as const, captureCount: 1, complete: true },
      { profileId: "mobile" as const, captureCount: 1, complete: true },
      { profileId: "reduced_motion" as const, captureCount: 1, complete: true },
      { profileId: "no_media" as const, captureCount: 1, complete: true },
    ],
    criticDisposition: "revise" as const,
    criticFindings: [{
      category: "hierarchy", code: "HIERARCHY_FLAT", routeId: "home", sectionIds: ["hero"],
      diagnosis: "The hierarchy is flat.", revision: "Strengthen the admitted hierarchy.",
    }],
    criticAttempt: 1,
  };
  const review = {
    heldOutPass: true,
    creativeCompilePass: true,
    criticDisposition: "revise" as const,
    ownerDecision: "pending" as const,
    status: "creative_review_required" as const,
    stopReason: "critic_unavailable" as const,
    attempts: [],
  };
  const reentered = statusAfterReview(seeded, review, null, null);
  assert.equal(reentered.renderManifestHash, seeded.renderManifestHash);
  assert.equal(reentered.criticAttempt, 1);
  assert.deepEqual(reentered.criticFindings, seeded.criticFindings);
  assert.equal(statusBeforeCreativeMutation(reentered).renderFresh, false);
});

test("tampered creative status records fail closed on invented render profiles and taste codes", () => {
  const results = mkdtempSync(join(tmpdir(), "creative-status-invalid-"));
  const valid = {
    ...statusAfterCompile(initialCreativePilotStatus(true, true), {
      outcome: "passed" as const, contractHash: HASH, findings: [], checkedAt: new Date().toISOString(),
    }),
    renderManifestHash: HASH,
    renderFresh: true,
    renderProfiles: [
      { profileId: "desktop" as const, captureCount: 1, complete: true },
      { profileId: "mobile" as const, captureCount: 1, complete: true },
      { profileId: "reduced_motion" as const, captureCount: 1, complete: true },
      { profileId: "no_media" as const, captureCount: 1, complete: true },
    ],
    criticDisposition: "revise" as const,
    criticFindings: [{
      category: "hierarchy", code: "HIERARCHY_FLAT", routeId: "home", sectionIds: ["hero"],
      diagnosis: "The hierarchy is flat.", revision: "Increase separation between headline and proof.",
    }],
    criticAttempt: 1,
    reviewState: "creative_review_required" as const,
  };
  writeCreativePilotStatus(results, valid);
  assert.notEqual(readCreativePilotStatus(results), null);

  writeFileSync(join(results, "creative-status.json"), JSON.stringify({
    ...valid,
    renderProfiles: valid.renderProfiles.map((profile, index) =>
      index === 0 ? { ...profile, profileId: "desktop-default" } : profile),
  }), "utf8");
  assert.equal(readCreativePilotStatus(results), null);

  writeFileSync(join(results, "creative-status.json"), JSON.stringify({
    ...valid,
    criticFindings: [{ ...valid.criticFindings[0], code: "GENERIC_HERO" }],
  }), "utf8");
  assert.equal(readCreativePilotStatus(results), null);
});

test("one atomic owner-decision claim wins; exact retries replay and conflicting decisions cannot mutate it", () => {
  const results = mkdtempSync(join(tmpdir(), "creative-decision-"));
  const first = claimCreativeDecision(results, "approved", null);
  const replay = claimCreativeDecision(results, "approved", null);
  const conflict = claimCreativeDecision(results, "cancelled", null);
  assert.equal(first.kind, "created");
  assert.equal(replay.kind, "replay");
  assert.equal(replay.claim.claimedAt, first.claim.claimedAt);
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.claim.decision, "approved");
});

test("concurrent owner-decision claimants have one filesystem winner and one conflict", async () => {
  const results = mkdtempSync(join(tmpdir(), "creative-decision-race-"));
  const moduleUrl = new URL("./creative-pilot.js", import.meta.url).href;
  const script = [
    `import { claimCreativeDecision } from ${JSON.stringify(moduleUrl)};`,
    "const result = claimCreativeDecision(process.argv[1], process.argv[2], null);",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const claim = async (decision: "approved" | "cancelled") => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, results, decision], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const [code] = await once(child, "close") as [number];
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout) as ReturnType<typeof claimCreativeDecision>;
  };

  const outcomes = await Promise.all([claim("approved"), claim("cancelled")]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["conflict", "created"]);
  const winner = outcomes.find((outcome) => outcome.kind === "created");
  assert.ok(winner);
  assert.equal(claimCreativeDecision(results, winner.claim.decision, null).kind, "replay");
  const loser = winner.claim.decision === "approved" ? "cancelled" : "approved";
  assert.equal(claimCreativeDecision(results, loser, null).kind, "conflict");
});
