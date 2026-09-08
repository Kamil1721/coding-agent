import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson, compileCreativeContract, sha256Hex } from "./creative-contract.js";
import type { CreativeContractV1 } from "./creative-contract.js";
import { CREATIVE_AUTHOR_FILE, CREATIVE_CONTRACT_FILE, CREATIVE_FACT_PROJECTION_VERSION, freshCreativeContract } from "./creative-pilot.js";
import { briefFactKind, briefFactSentences } from "./creative-brief-facts.js";
import { clinicAuthorBytes, clinicHistorical, clinicHistoricalBytes, clinicPacket, clinicTicketText, deriveClinicContract } from "./test-fixtures/clinic-t21.js";

const frozenHash = "201a2aee2ebd2e2d0b9a92068c9f46a8be90d4c4d272cdedec9a8f9e3689448f";
const legacyInputHash = "ed974f41fe8b01e882ada21fc11cf67bc7b1cb100c54ae4f129091ee343da0ef";
const derived = JSON.parse(readFileSync(new URL("../src/test-fixtures/clinic-t21-derived.json", import.meta.url), "utf8")) as CreativeContractV1;

test("T21 bare contrast is an accessibility requirement", () => {
  assert.equal(briefFactKind("Maintain sufficient contrast."), "accessibility", "T21 bare contrast cue must classify accessibility");
});

test("T21 standalone deterministic is an implementation constraint", () => {
  assert.equal(briefFactKind("Use deterministic fixture data."), "constraint", "T21 standalone deterministic cue must classify a constraint");
});

test("T21 clinic sentences distinguish product transitions from requirements", () => {
  const packet = clinicPacket();
  const facts = packet.input.ticket.facts;
  for (const anchor of ["Choose one of exactly three appointment types", "Back must preserve", "Reset must return"]) {
    const fact = facts.find((item) => item.statement.startsWith(anchor));
    assert.equal(fact?.kind, "goal", `T21 product sentence must stay goal: ${anchor}`);
  }
  assert.equal(facts.find((fact) => fact.statement.startsWith("The layout must work at 375px"))?.kind, "constraint", "T21 layout sentence must be a constraint");
  const mixed = briefFactSentences(clinicTicketText.split("\n").find((line) => line.startsWith("Include Back"))!);
  assert.ok(mixed.some((sentence) => briefFactKind(sentence) === "goal"));
  assert.ok(mixed.some((sentence) => briefFactKind(sentence) === "constraint"), "T21 mixed product paragraph must preserve a separate constraint");
  assert.equal(briefFactKind("At 375px controls must remain visible."), "constraint");
  for (const [index, fact] of facts.entries()) {
    assert.equal(fact.id, `ticket.${fact.kind === "goal" ? "goal" : "req"}.${String(index + 1)}`);
    assert.equal(fact.evidence.locator, `ticket:${packet.input.ticket.id}:brief:${String(index + 1)}`);
    assert.equal(packet.resolver.resolve(fact.evidence)?.factKind, fact.kind, "T21 every resolved fact must report its host kind");
  }
  assert.equal(packet.input.designFacts[0]?.kind, "technical_constraint");
});

test("T21 derived clinic fixture equals regeneration from the real sentence splitter", () => {
  assert.deepEqual(deriveClinicContract(), derived, "T21 derived fixture must equal splitter regeneration, including every evidence locator and digest");
  const visible = (contract: CreativeContractV1) => ({ ...contract, contentProof: contract.contentProof.map(({ evidence: _evidence, ...proof }) => proof) });
  assert.deepEqual(visible(derived), visible(clinicHistorical), "T21 derivation may change evidence references only");
  assert.equal(sha256Hex(canonicalJson(clinicHistorical)), frozenHash, "T21 historical clinic contract must remain unchanged");
});

test("T21 derived clinic rejects exactly six requirement proofs and no product proofs", () => {
  const result = compileCreativeContract(JSON.stringify(derived), clinicPacket().resolver);
  assert.equal(result.ok, false, "T21 exact-six requirement oracle must exclude every product proof, including p.reset");
  const ids = result.errors.filter((error) => error.code === "REQUIREMENT_AS_COPY" && /^\/contentProof\/\d+$/u.test(error.path))
    .map((error) => derived.contentProof[Number(error.path.split("/")[2])]!.id).sort();
  assert.deepEqual(ids, ["p.a11y", "p.focus", "p.local", "p.markers", "p.responsive", "p.run"], "T21 exact-six requirement oracle must exclude every product proof, including p.reset");
  const sections = result.errors.filter((error) => error.code === "REQUIREMENT_SECTION")
    .map((error) => derived.sections[Number(error.path.split("/")[2])]!.id).sort();
  assert.deepEqual(sections, ["s.a11y", "s.local", "s.responsive", "s.run"]);
  assert.ok(result.errors.some((error) => error.code === "REQUIREMENT_AS_COPY" && error.path === "/sections/9/contentRefs/1"), "T21 host.web-surface is technical_constraint and can never become body copy in a new contract");
});

test("T21 frozen pre-T21 clinic still compiles through the actual legacy fresh-read path", (t) => {
  const results = mkdtempSync(join(tmpdir(), "t21-frozen-"));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  writeFileSync(join(results, CREATIVE_AUTHOR_FILE), clinicAuthorBytes);
  writeFileSync(join(results, CREATIVE_CONTRACT_FILE), clinicHistoricalBytes);
  assert.equal((JSON.parse(clinicAuthorBytes) as { inputHash: string }).inputHash, legacyInputHash);
  const read = freshCreativeContract(results, clinicPacket().resolver);
  assert.equal(read.fresh?.contractHash, frozenHash, "T21 unchanged frozen clinic must compile via matched legacy packet, including its host-surface proof");
  assert.deepEqual(read.fresh?.contract, clinicHistorical);
});

test("T21 frozen compatibility refuses missing, changed, new or unknown projection qualifications", (t) => {
  const results = mkdtempSync(join(tmpdir(), "t21-qualifications-"));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  const author = JSON.parse(clinicAuthorBytes) as Record<string, unknown>;
  const packet = clinicPacket();
  for (const [name, patch] of Object.entries({
    "missing input hash": { inputHash: undefined },
    "changed input hash": { inputHash: "f".repeat(64) },
    "new packet hash without marker": { inputHash: sha256Hex(canonicalJson(packet.input)) },
    "new projection marker": { projectionVersion: CREATIVE_FACT_PROJECTION_VERSION },
    "unknown projection marker": { projectionVersion: 99 },
    "changed frozen contract hash": { contractHash: "f".repeat(64) },
  })) {
    writeFileSync(join(results, CREATIVE_AUTHOR_FILE), JSON.stringify({ ...author, ...patch }));
    writeFileSync(join(results, CREATIVE_CONTRACT_FILE), clinicHistoricalBytes);
    assert.equal(freshCreativeContract(results, packet.resolver).fresh, null, `T21 ${name} must not enable frozen compatibility`);
  }
  writeFileSync(join(results, CREATIVE_AUTHOR_FILE), clinicAuthorBytes);
  writeFileSync(join(results, CREATIVE_CONTRACT_FILE), JSON.stringify({ ...clinicHistorical, contractId: "changed" }));
  const changed = freshCreativeContract(results, packet.resolver);
  assert.equal(changed.fresh, null, "T21 changed contract bytes must not enable frozen compatibility");
  assert.ok(changed.compile.findings.some((finding) => finding.code === "EVIDENCE_NOT_FOUND"), "T21 changed contract bytes must use strict evidence, never the legacy resolver");
});

test("T21 current valid frozen contract rejects an unknown projection version", (t) => {
  const results = mkdtempSync(join(tmpdir(), "t21-version-"));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  // Product-only fixture with a valid hash ensures refusal is about version, not evidence.
  const resolver = { resolve: (ref: CreativeContractV1["contentProof"][number]["evidence"]) => ({ sha256: ref.sha256, excerptSha256: ref.excerptSha256, factKind: "goal" as const }) };
  writeFileSync(join(results, CREATIVE_CONTRACT_FILE), clinicHistoricalBytes);
  writeFileSync(join(results, CREATIVE_AUTHOR_FILE), JSON.stringify({ status: "compiled", contractHash: frozenHash, projectionVersion: 99 }));
  assert.equal(freshCreativeContract(results, resolver).fresh, null, "T21 unknown projection version must fail closed even with otherwise valid evidence");
});
