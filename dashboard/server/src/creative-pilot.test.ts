import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ticket } from "bakeoff/dist/contracts.js";

import { compileCreativeContract } from "./creative-contract.js";
import type { CreativeContractV1 } from "./creative-contract.js";
import type { CreativeContractAuthorResult } from "./creative-contract-author.js";
import {
  CREATIVE_AUTHOR_FILE,
  CREATIVE_COMPILE_FILE,
  CREATIVE_CONTRACT_FILE,
  CREATIVE_PILOT_PROJECT_ID,
  authorInputFor,
  claimCreativeDecision,
  creativeContractPrompt,
  creativePilotEnabled,
  freshCreativeContract,
  initialCreativePilotStatus,
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

test("compiled author result is atomically durable and freshness compilation fails closed after tampering", () => {
  const results = mkdtempSync(join(tmpdir(), "creative-pilot-"));
  const input = authorInputFor(TICKET, null);
  const contract = validContract(input);
  const compiled = compileCreativeContract(JSON.stringify(contract), input.resolver);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const result: CreativeContractAuthorResult = {
    schemaVersion: 1, status: "compiled", ran: true, inputHash: HASH, promptHash: HASH,
    contractHash: compiled.contractHash, contract: compiled.contract, errors: [], compileErrors: [], detail: "ok",
    tokens: null, rateLimit: null, authorBy: "test",
  };
  const compile = persistCreativeAuthorResult(results, result);
  assert.equal(compile.outcome, "passed");
  assert.equal(existsSync(join(results, CREATIVE_AUTHOR_FILE)), true);
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

test("builder projection binds the hash and all host capture markers", () => {
  const input = authorInputFor(TICKET, null);
  const compiled = compileCreativeContract(JSON.stringify(validContract(input)), input.resolver);
  assert.equal(compiled.ok, true);
  const prompt = creativeContractPrompt({ contract: compiled.contract, contractHash: compiled.contractHash });
  assert.match(prompt, new RegExp(compiled.contractHash, "u"));
  assert.match(prompt, /data-creative-route/u);
  assert.match(prompt, /data-creative-section/u);
  assert.match(prompt, /data-motion-id/u);
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
    criticDisposition: "accept" as const,
    reviewState: "creative_ready" as const,
    ownerDecision: "approved" as const,
  };
  assert.equal(pilotMayPublish(ready), true);
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
