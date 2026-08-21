import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  MAX_TASTE_FINDINGS,
  MAX_TASTE_FINDINGS_PER_CATEGORY,
  TASTE_CODE_CATEGORY,
  buildTasteCriticPrompt,
  parseTasteCriticOutput,
} from "./taste-policy.js";
import type {
  TasteCategory,
  TasteCriticOutputV1,
  TasteEvidence,
  TasteEvidenceIndex,
  TasteFindingCode,
  TasteFindingV1,
} from "./taste-policy.js";

const CONTRACT_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);
const TEXT_HASH = "c".repeat(64);
const SCREENSHOT_HASH = "d".repeat(64);
const VALUE_HASH = "e".repeat(64);

const DOM_EVIDENCE: TasteEvidence = {
  kind: "dom_text",
  frameId: "desktop",
  sectionId: "hero",
  excerpt: "Turn scattered work into one accountable run.",
  textSha256: TEXT_HASH,
};

const CONTRACT_EVIDENCE: TasteEvidence = {
  kind: "contract",
  pointer: "/contentProof/0",
  valueSha256: VALUE_HASH,
};

const REGION_EVIDENCE: TasteEvidence = {
  kind: "region",
  frameId: "desktop",
  sectionId: "hero",
  screenshotSha256: SCREENSHOT_HASH,
  box: { x: 24, y: 80, width: 720, height: 480 },
};

const MOTION_EVIDENCE: TasteEvidence = {
  kind: "motion_trace",
  frameId: "desktop",
  motionId: "hero-reveal",
  sampleIndexes: [0, 1],
  observedProperties: ["opacity", "transform"],
};

const INDEX: TasteEvidenceIndex = {
  contractHash: CONTRACT_HASH,
  renderManifestHash: MANIFEST_HASH,
  routes: [{ id: "home", sectionIds: ["hero", "proof"] }],
  frames: [
    { id: "desktop", routeId: "home", sectionIds: ["hero", "proof"], motionIds: ["hero-reveal"] },
    { id: "mobile", routeId: "home", sectionIds: ["hero", "proof"], motionIds: ["hero-reveal"] },
    { id: "reduced", routeId: "home", sectionIds: ["hero", "proof"], motionIds: ["hero-reveal"] },
  ],
  contractPointers: [
    "/contentProof/0",
    "/sections/hero/job",
    "/sections/hero/layoutFamily",
    "/motion/hero-reveal/rationale",
  ],
  evidence: [DOM_EVIDENCE, CONTRACT_EVIDENCE, REGION_EVIDENCE, MOTION_EVIDENCE],
};

function validFinding(overrides: Partial<TasteFindingV1> = {}): TasteFindingV1 {
  return {
    id: "taste-copy-1",
    category: "copy",
    code: "GENERIC_COPY",
    routeId: "home",
    sectionIds: ["hero"],
    diagnosis: "The hero repeats a generic transformation claim while the contract requires a concrete workflow proof.",
    revision: "Replace the claim with the named input, operation, and observable owner outcome already supported by the proof section.",
    evidence: [DOM_EVIDENCE, CONTRACT_EVIDENCE],
    ...overrides,
  };
}

function validOutput(findings: readonly TasteFindingV1[] = [validFinding()]): TasteCriticOutputV1 {
  return {
    schemaVersion: 1,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    findings,
  };
}

function parse(value: unknown) {
  return parseTasteCriticOutput(JSON.stringify(value), INDEX);
}

function errorCodes(value: unknown): readonly string[] {
  const result = parse(value);
  assert.equal(result.ok, false);
  return result.errors.map((error) => error.code);
}

test("accepts a closed, grounded critic result and treats no findings as the only clean signal", () => {
  const result = parse(validOutput());
  assert.equal(result.ok, true);
  assert.equal(result.output.findings.length, 1);
  assert.equal(result.output.findings[0]?.code, "GENERIC_COPY");

  const empty = parse(validOutput([]));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.output.findings, []);
});

test("rejects prose around JSON instead of extracting a convenient object", () => {
  const result = parseTasteCriticOutput(`Verdict: fail\n${JSON.stringify(validOutput())}`, INDEX);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["INVALID_JSON"]);
});

test("rejects unknown keys at every closed object boundary", () => {
  const root = { ...validOutput(), verdict: "fail" };
  assert.ok(errorCodes(root).includes("UNKNOWN_KEY"));

  const finding = { ...validFinding(), severity: "high" };
  assert.ok(errorCodes(validOutput([finding as unknown as TasteFindingV1])).includes("UNKNOWN_KEY"));

  const evidence = { ...DOM_EVIDENCE, confidence: 0.9 };
  assert.ok(
    errorCodes(validOutput([validFinding({ evidence: [evidence as unknown as TasteEvidence, CONTRACT_EVIDENCE] })])).includes(
      "UNKNOWN_KEY",
    ),
  );

  const region = { ...REGION_EVIDENCE, box: { ...REGION_EVIDENCE.box, right: 744 } };
  assert.ok(
    errorCodes(validOutput([validFinding({ evidence: [region as unknown as TasteEvidence, CONTRACT_EVIDENCE] })])).includes(
      "UNKNOWN_KEY",
    ),
  );
});

test("requires exact immutable artefact hashes", () => {
  assert.ok(errorCodes({ ...validOutput(), contractHash: "f".repeat(64) }).includes("WRONG_CONTRACT_HASH"));
  assert.ok(errorCodes({ ...validOutput(), renderManifestHash: "f".repeat(64) }).includes("WRONG_RENDER_MANIFEST_HASH"));
});

test("rejects unsupported frame, section, motion and contract pointer references", () => {
  const badFrame = { ...DOM_EVIDENCE, frameId: "tablet" };
  assert.ok(
    errorCodes(validOutput([validFinding({ evidence: [badFrame as TasteEvidence, CONTRACT_EVIDENCE] })])).includes("UNKNOWN_FRAME"),
  );

  const badSection = { ...DOM_EVIDENCE, sectionId: "pricing" };
  assert.ok(
    errorCodes(validOutput([validFinding({ evidence: [badSection as TasteEvidence, CONTRACT_EVIDENCE] })])).includes(
      "UNKNOWN_SECTION",
    ),
  );

  const badMotion = { ...MOTION_EVIDENCE, motionId: "decorative-orbit" };
  assert.ok(
    errorCodes(
      validOutput([
        validFinding({
          id: "taste-motion-1",
          category: "motion",
          code: "MOTION_UNDECLARED",
          evidence: [badMotion as TasteEvidence, DOM_EVIDENCE],
        }),
      ]),
    ).includes("UNKNOWN_MOTION"),
  );

  const badPointer = { ...CONTRACT_EVIDENCE, pointer: "/palette/accent" };
  assert.ok(
    errorCodes(validOutput([validFinding({ evidence: [DOM_EVIDENCE, badPointer as TasteEvidence] })])).includes(
      "UNKNOWN_CONTRACT_POINTER",
    ),
  );
});

test("rejects fabricated evidence even when its coordinates are otherwise supported", () => {
  const fabricated = { ...DOM_EVIDENCE, textSha256: "f".repeat(64) };
  assert.ok(
    errorCodes(validOutput([validFinding({ evidence: [fabricated as TasteEvidence, CONTRACT_EVIDENCE] })])).includes(
      "UNKNOWN_EVIDENCE_REFERENCE",
    ),
  );
});

test("requires two distinct grounded evidence references", () => {
  const one = validOutput([validFinding({ evidence: [DOM_EVIDENCE] })]);
  const oneCodes = errorCodes(one);
  assert.ok(oneCodes.includes("LIMIT_EXCEEDED"));
  assert.ok(oneCodes.includes("TOO_FEW_GROUNDED_EVIDENCE"));

  const duplicate = validOutput([validFinding({ evidence: [DOM_EVIDENCE, DOM_EVIDENCE] })]);
  const duplicateCodes = errorCodes(duplicate);
  assert.ok(duplicateCodes.includes("DUPLICATE_VALUE"));
  assert.ok(duplicateCodes.includes("TOO_FEW_GROUNDED_EVIDENCE"));
});

test("rejects category and code mismatches", () => {
  const codes = errorCodes(validOutput([validFinding({ category: "layout", code: "GENERIC_COPY" })]));
  assert.ok(codes.includes("CATEGORY_CODE_MISMATCH"));
});

test("enforces total and per-category finding bounds", () => {
  const copyFindings = [0, 1, 2].map((index) => validFinding({ id: `taste-copy-${String(index)}` }));
  assert.ok(errorCodes(validOutput(copyFindings)).includes("LIMIT_EXCEEDED"));
  assert.equal(MAX_TASTE_FINDINGS_PER_CATEGORY, 2);

  const categoryCodes: readonly (readonly [TasteCategory, TasteFindingCode])[] = [
    ["copy", "GENERIC_COPY"],
    ["layout", "LAYOUT_GRAMMAR_REPEATED"],
    ["motion", "MOTION_UNDECLARED"],
    ["imagery", "IMAGE_PROVENANCE_UNKNOWN"],
    ["hierarchy", "HIERARCHY_FLAT"],
    ["mobile", "MOBILE_REFLOW_BROKEN"],
    ["reduced_motion", "REDUCED_MOTION_ACTIVE"],
  ];
  const tooMany = Array.from({ length: MAX_TASTE_FINDINGS + 1 }, (_, index) => {
    const pair = categoryCodes[Math.floor(index / 2)];
    assert.ok(pair);
    const [category, code] = pair;
    assert.equal(TASTE_CODE_CATEGORY[code], category);
    return validFinding({ id: `taste-${String(index)}`, category, code });
  });
  assert.ok(errorCodes(validOutput(tooMany)).includes("LIMIT_EXCEEDED"));
});

test("rejects preference-only diagnoses while retaining evidence-based aesthetic findings", () => {
  assert.ok(
    errorCodes(validOutput([validFinding({ diagnosis: "I prefer a more modern, premium look." })])).includes(
      "PREFERENCE_ONLY_DIAGNOSIS",
    ),
  );

  const grounded = validOutput([
    validFinding({
      diagnosis: "The same layout grammar repeats in the hero and proof sections, flattening their distinct section jobs.",
      category: "layout",
      code: "LAYOUT_GRAMMAR_REPEATED",
    }),
  ]);
  assert.equal(parse(grounded).ok, true);
});

test("builds a bounded one-turn prompt without a prose verdict or aesthetic monoculture", () => {
  const prompt = buildTasteCriticPrompt({
    evidenceIndex: INDEX,
    facts: [
      { id: "fact-copy", evidence: DOM_EVIDENCE, observation: "Hero and proof use the same transformation claim." },
      { id: "fact-contract", evidence: CONTRACT_EVIDENCE, observation: "The contract requires a concrete workflow proof." },
      { id: "fact-region", evidence: REGION_EVIDENCE, observation: "The two primary actions have equal visual weight." },
      { id: "fact-motion", evidence: MOTION_EVIDENCE, observation: "The reveal moves before its related heading enters view." },
    ],
    intentionalExceptions: [
      { rule: "CENTERED_HERO", sectionIds: ["hero"], rationale: "The single-action invitation is intentionally ceremonial." },
    ],
  });

  assert.match(prompt, /one tool-less turn/u);
  assert.match(prompt, /Do not impose an aesthetic monoculture/u);
  assert.match(prompt, /Never penalize a declared intentional exception by itself/u);
  assert.match(prompt, /generic copy/u);
  assert.match(prompt, /repeated section grammar/u);
  assert.match(prompt, /unknown provenance/u);
  assert.match(prompt, /broken reflow/u);
  assert.match(prompt, /reduced motion/u);
  assert.match(prompt, /no Markdown fence, score, severity, summary, commentary, or prose verdict/u);
  assert.doesNotMatch(prompt, /data:image\//u);
  assert.ok(prompt.length < 40_000);
});

test("prompt builder refuses raw source and image byte payloads", () => {
  assert.throws(
    () =>
      buildTasteCriticPrompt({
        evidenceIndex: INDEX,
        facts: [{ id: "raw", evidence: DOM_EVIDENCE, observation: "data:image/png;base64,AAAA" }],
        intentionalExceptions: [],
      }),
    /not source or image bytes/u,
  );
  assert.throws(
    () =>
      buildTasteCriticPrompt({
        evidenceIndex: INDEX,
        facts: [{ id: "source", evidence: DOM_EVIDENCE, observation: "const layout = renderPage();" }],
        intentionalExceptions: [],
      }),
    /not source or image bytes/u,
  );
});
