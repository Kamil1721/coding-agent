import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CREATIVE_CONTRACT_V1_COMPILER_CONSTRAINTS,
  CREATIVE_CONTRACT_V1_JSON_SCHEMA,
  compileCreativeContract,
} from "./creative-contract.js";
import type {
  CreativeCompilerConstraint,
  CreativeContractV1,
  CreativeEvidenceRef,
  CreativeEvidenceResolver,
  CreativeSectionV1,
} from "./creative-contract.js";

const SOURCE_HASH = "a".repeat(64);
const EXCERPT_HASH = "b".repeat(64);

const EVIDENCE: CreativeEvidenceRef = {
  kind: "owner_message",
  locator: "message:brief-1",
  sha256: SOURCE_HASH,
  excerptSha256: EXCERPT_HASH,
};

const RESOLVER: CreativeEvidenceResolver = {
  resolve(reference) {
    return reference.locator === EVIDENCE.locator ? { sha256: SOURCE_HASH, excerptSha256: EXCERPT_HASH } : null;
  },
};

function proof(id: string, allowedUses: readonly ("headline" | "action")[] = ["headline"]) {
  return { id, claim: `Owner-supported statement ${id}.`, status: "supported_paraphrase" as const, evidence: EVIDENCE, allowedUses };
}

function section(
  id: string,
  routeId: string,
  order: number,
  kind: CreativeSectionV1["kind"],
  layoutFamily: CreativeSectionV1["layoutFamily"],
  visualKind: CreativeSectionV1["visualKind"],
  options: { readonly action?: boolean; readonly body?: string | null; readonly mobile?: CreativeSectionV1["mobile"] } = {},
): CreativeSectionV1 {
  const action = options.action === true;
  const body = options.body ?? null;
  return {
    id,
    routeId,
    order,
    kind,
    job: `Give ${routeId} visitors one concrete ${kind} decision.`,
    contentRefs: [{ proofId: `proof-${id}`, use: "headline" }],
    eyebrow: null,
    headline: `Concrete ${kind} for ${routeId}`,
    body,
    actions: action
      ? [{ id: `action-${id}`, label: "Start review", intent: "signup", priority: "primary", href: "/start", proofId: `proof-${id}` }]
      : [],
    layoutFamily,
    visualKind,
    mobile: options.mobile ?? {
      strategy: layoutFamily === "bento" || layoutFamily === "asymmetric_split" ? "stack" : "preserve",
      contentOrder: ["headline", ...(body === null ? [] : ["body"]), ...(visualKind === "none" ? [] : ["visual"]), ...(action ? ["actions"] : [])] as CreativeSectionV1["mobile"]["contentOrder"],
    },
    requiredStates: action ? ["default", "interaction"] : ["default"],
  };
}

function validContract(): CreativeContractV1 {
  const sections = [
    section("home-hero", "home", 0, "hero", "asymmetric_split", "generated_image", { action: true, body: "See each decision, its evidence, and the next accountable action." }),
    section("home-proof", "home", 1, "proof", "bento", "brand_asset"),
    section("home-footer", "home", 2, "footer", "footer_columns", "none"),
    section("work-hero", "work", 0, "hero", "editorial_manifesto", "generated_image"),
    section("work-gallery", "work", 1, "gallery", "gallery_grid", "licensed_image"),
    section("work-footer", "work", 2, "footer", "footer_columns", "none"),
  ];
  return {
    schemaVersion: 1,
    contractId: "contract-valid",
    designRead: {
      pageKind: "saas_landing",
      audience: "Technical owners evaluating accountable delivery workflows.",
      vibe: "Direct, industrial and evidence-led.",
      aestheticFamily: "industrial",
      designSystem: "tailwind",
      displayStyle: "sans",
      paletteFamily: "neutral_pop",
      theme: "dark",
      thesis: "Every section turns invisible agent work into an inspectable owner decision.",
    },
    dials: { designVariance: 7, motionIntensity: 6, visualDensity: 5 },
    contentProof: sections.map((item) => proof(`proof-${item.id}`, item.actions.length > 0 ? ["headline", "action"] : ["headline"])),
    routes: [
      { id: "home", path: "/", sectionIds: ["home-hero", "home-proof", "home-footer"] },
      { id: "work", path: "/work", sectionIds: ["work-hero", "work-gallery", "work-footer"] },
    ],
    sections,
    motion: [
      {
        id: "home-reveal", routeId: "home", sectionId: "home-hero", target: "hero copy group", purpose: "hierarchy",
        trigger: "enter_view", implementation: "motion", properties: ["opacity", "transform"],
        rationale: "Reveal the value statement before the supporting visual.",
        fallback: { reducedMotion: "static", noMedia: "static_asset" }, sourceStillKind: "illustration", simulationAuthorized: false,
      },
      {
        id: "work-gallery-focus", routeId: "work", sectionId: "work-gallery", target: "selected work item", purpose: "feedback",
        trigger: "enter_view", implementation: "css", properties: ["transform"],
        rationale: "Confirm which project the visitor is inspecting.",
        fallback: { reducedMotion: "instant", noMedia: "content_equivalent" }, sourceStillKind: "none", simulationAuthorized: false,
      },
    ],
    intentionalExceptions: [],
  };
}

function compile(contract: CreativeContractV1, resolver = RESOLVER) {
  return compileCreativeContract(JSON.stringify(contract), resolver);
}

function codes(contract: CreativeContractV1, resolver = RESOLVER): readonly string[] {
  const result = compile(contract, resolver);
  assert.equal(result.ok, false);
  return result.errors.map((item) => item.code);
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutableContract(): Mutable<CreativeContractV1> {
  return structuredClone(validContract()) as Mutable<CreativeContractV1>;
}

test("compiles a valid multi-route contract with motivated motion and a stable canonical hash", () => {
  const contract = validContract();
  const result = compile(contract);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.contractHash, /^[a-f0-9]{64}$/u);

  const reordered = {
    intentionalExceptions: contract.intentionalExceptions,
    motion: contract.motion,
    sections: contract.sections,
    routes: contract.routes,
    contentProof: contract.contentProof,
    dials: contract.dials,
    designRead: contract.designRead,
    contractId: contract.contractId,
    schemaVersion: contract.schemaVersion,
  };
  const second = compileCreativeContract(JSON.stringify(reordered), RESOLVER);
  assert.equal(second.ok, true);
  assert.equal(second.contractHash, result.contractHash);
  assert.equal(second.canonicalJson, result.canonicalJson);
});

test("structured-output schema exhaustively matches compiler shape, vocabularies, nullability and bounds", () => {
  const base = mutableContract();
  base.sections[0]!.layoutFamily = "centered_hero";
  base.intentionalExceptions = [{
    rule: "CENTERED_HERO", routeId: "home", sectionIds: ["home-hero"],
    rationale: "The owner approved a ceremonial single-action opening.", evidence: { ...EVIDENCE },
  }];
  assert.equal(compile(base).ok, true, "the exhaustive parity fixture itself must remain compiler-green");

  type Schema = Readonly<Record<string, unknown>>;
  const schemaConstraints = (root: Schema): Readonly<Record<string, CreativeCompilerConstraint>> => {
    const constraints: Record<string, CreativeCompilerConstraint> = {};
    const collect = (schema: Schema, path: string): void => {
      const rawType = schema["type"];
      const types = Array.isArray(rawType) ? rawType as readonly string[] : [rawType as string];
      if (types.includes("object")) {
        constraints[path] = {
          type: "object",
          required: schema["required"] as readonly string[],
          additionalProperties: false,
        };
        const properties = schema["properties"] as Readonly<Record<string, Schema>>;
        for (const [key, child] of Object.entries(properties)) collect(child, path === "/" ? `/${key}` : `${path}/${key}`);
        return;
      }
      if (types.includes("array")) {
        constraints[path] = {
          type: "array",
          minItems: schema["minItems"] as number,
          maxItems: schema["maxItems"] as number,
          uniqueItems: schema["uniqueItems"] === true,
        };
        collect(schema["items"] as Schema, `${path}/*`);
        return;
      }
      if (types.includes("string")) {
        constraints[path] = {
          type: "string",
          nullable: types.includes("null"),
          minLength: schema["minLength"] as number,
          maxLength: schema["maxLength"] as number,
          pattern: schema["pattern"] as string | undefined ?? null,
          enum: schema["enum"] as readonly string[] | undefined ?? null,
        };
        return;
      }
      if (types.includes("integer")) {
        constraints[path] = {
          type: "integer",
          minimum: schema["minimum"] as number | undefined ?? null,
          maximum: schema["maximum"] as number | undefined ?? null,
          constValue: schema["const"] as number | undefined ?? null,
        };
        return;
      }
      assert.deepEqual(types, ["boolean"], `unrecognised schema type at ${path}`);
      constraints[path] = { type: "boolean" };
    };
    collect(root, "/");
    return constraints;
  };
  const assertBidirectionalConstraints = (schema: Schema): void => {
    assert.deepEqual(schemaConstraints(schema), CREATIVE_CONTRACT_V1_COMPILER_CONSTRAINTS);
  };
  assertBidirectionalConstraints(CREATIVE_CONTRACT_V1_JSON_SCHEMA);

  const weakened = structuredClone(CREATIVE_CONTRACT_V1_JSON_SCHEMA) as Record<string, unknown>;
  const weakenedProperties = weakened["properties"] as Record<string, Record<string, unknown>>;
  delete weakenedProperties["contractId"]?.["maxLength"];
  assert.throws(
    () => assertBidirectionalConstraints(weakened),
    /maxLength/u,
    "removing a schema constraint must make parity fail even though traversal can no longer discover it",
  );

  const pointer = (parts: readonly (string | number)[]): string => `/${parts.map(String).join("/")}`;
  const setAt = (root: unknown, parts: readonly (string | number)[], value: unknown): void => {
    let cursor = root as Record<string | number, unknown>;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string | number, unknown>;
    const key = parts.at(-1);
    assert.notEqual(key, undefined);
    cursor[key!] = value;
  };
  const deleteAt = (root: unknown, parts: readonly (string | number)[]): void => {
    let cursor = root as Record<string | number, unknown>;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string | number, unknown>;
    delete cursor[parts.at(-1)!];
  };
  const findings = (mutate: (contract: Mutable<CreativeContractV1>) => void) => {
    const contract = structuredClone(base);
    mutate(contract);
    const result = compileCreativeContract(JSON.stringify(contract), RESOLVER);
    return result.ok ? [] : result.errors;
  };
  const has = (
    errors: readonly { readonly code: string; readonly path: string }[],
    code: string,
    path: string,
  ): boolean => errors.some((error) => error.code === code && error.path === path);
  const lacksShapeFinding = (
    errors: readonly { readonly code: string; readonly path: string }[],
    path: string,
  ): boolean => !errors.some((error) => error.path === path && ["INVALID_TYPE", "INVALID_VALUE", "LIMIT_EXCEEDED"].includes(error.code));

  const visit = (schema: Schema, sample: unknown, path: readonly (string | number)[]): void => {
    const type = schema["type"];
    if (type === "object") {
      assert.equal(schema["additionalProperties"], false, `${pointer(path)} must be closed`);
      const properties = schema["properties"] as Readonly<Record<string, Schema>>;
      const required = schema["required"] as readonly string[];
      assert.deepEqual([...required].sort(), Object.keys(properties).sort(), `${pointer(path)} required/schema keys drifted`);
      assert.deepEqual(Object.keys(sample as object).sort(), Object.keys(properties).sort(), `${pointer(path)} fixture/schema keys drifted`);
      for (const [key, child] of Object.entries(properties)) {
        const childPath = [...path, key];
        const errors = findings((contract) => deleteAt(contract, childPath));
        assert.ok(has(errors, "MISSING_KEY", pointer(childPath)), `compiler did not require ${pointer(childPath)}`);
        visit(child, (sample as Record<string, unknown>)[key], childPath);
      }
      return;
    }
    if (type === "array") {
      const values = sample as readonly unknown[];
      const min = schema["minItems"] as number;
      const max = schema["maxItems"] as number;
      if (min > 0) {
        assert.ok(has(findings((contract) => setAt(contract, path, [])), "LIMIT_EXCEEDED", pointer(path)));
      }
      const exemplar = values[0];
      assert.notEqual(exemplar, undefined, `${pointer(path)} needs an exemplar for exhaustive parity`);
      const tooMany = Array.from({ length: max + 1 }, () => structuredClone(exemplar));
      assert.ok(has(findings((contract) => setAt(contract, path, tooMany)), "LIMIT_EXCEEDED", pointer(path)));
      if (schema["uniqueItems"] === true && max >= 2) {
        const duplicates = [structuredClone(exemplar), structuredClone(exemplar)];
        const errors = findings((contract) => setAt(contract, path, duplicates));
        assert.ok(errors.some((error) => error.code === "DUPLICATE_VALUE" && error.path.startsWith(`${pointer(path)}/`)));
      }
      visit(schema["items"] as Schema, exemplar, [...path, 0]);
      return;
    }

    const enumValues = schema["enum"] as readonly string[] | undefined;
    if (enumValues !== undefined) {
      for (const value of enumValues) {
        const errors = findings((contract) => setAt(contract, path, value));
        assert.ok(lacksShapeFinding(errors, pointer(path)), `compiler rejected schema enum ${value} at ${pointer(path)}`);
      }
      assert.ok(has(findings((contract) => setAt(contract, path, "__outside_closed_vocabulary__")), "INVALID_VALUE", pointer(path)));
    }
    if (schema["const"] !== undefined) {
      assert.ok(has(findings((contract) => setAt(contract, path, 2)), "INVALID_VALUE", pointer(path)));
    }
    const types = Array.isArray(type) ? type as readonly string[] : [type as string];
    if (types.includes("null")) {
      const errors = findings((contract) => setAt(contract, path, null));
      assert.ok(lacksShapeFinding(errors, pointer(path)), `compiler rejected nullable ${pointer(path)}`);
    }
    if (types.includes("string")) {
      assert.ok(has(findings((contract) => setAt(contract, path, 7)), "INVALID_TYPE", pointer(path)));
      const max = schema["maxLength"] as number | undefined;
      const min = schema["minLength"] as number | undefined;
      if (min !== undefined) {
        assert.ok(
          has(findings((contract) => setAt(contract, path, "")), "LIMIT_EXCEEDED", pointer(path)),
          `compiler minimum string bound drifted at ${pointer(path)}`,
        );
      }
      if (max !== undefined) {
        assert.ok(
          has(findings((contract) => setAt(contract, path, "x".repeat(max + 1))), "LIMIT_EXCEEDED", pointer(path)),
          `compiler maximum string bound drifted at ${pointer(path)}`,
        );
      }
      const pattern = schema["pattern"] as string | undefined;
      if (pattern !== undefined && pattern !== "\\S") {
        const invalid = pattern.includes("a-f0-9") ? "g".repeat(64) : "not a valid formatted value";
        assert.ok(has(findings((contract) => setAt(contract, path, invalid)), "INVALID_VALUE", pointer(path)));
      }
    }
    if (types.includes("integer")) {
      const wrongType = findings((contract) => setAt(contract, path, "7"));
      assert.ok(
        has(wrongType, "INVALID_TYPE", pointer(path)) || has(wrongType, "INVALID_VALUE", pointer(path)),
        `compiler accepted a non-integer at ${pointer(path)}`,
      );
      const min = schema["minimum"] as number | undefined;
      const max = schema["maximum"] as number | undefined;
      if (min !== undefined) {
        assert.ok(has(findings((contract) => setAt(contract, path, min - 1)), "LIMIT_EXCEEDED", pointer(path)));
      }
      if (max !== undefined) {
        assert.ok(has(findings((contract) => setAt(contract, path, max + 1)), "LIMIT_EXCEEDED", pointer(path)));
      }
    }
    if (types.includes("boolean")) {
      assert.ok(has(findings((contract) => setAt(contract, path, "false")), "INVALID_TYPE", pointer(path)));
    }
  };

  visit(CREATIVE_CONTRACT_V1_JSON_SCHEMA, base, []);
});

test("rejects prose, unknown nested keys and closed-enum escape attempts", () => {
  const contract = validContract();
  const prose = compileCreativeContract(`contract:\n${JSON.stringify(contract)}`, RESOLVER);
  assert.equal(prose.ok, false);
  assert.deepEqual(prose.errors.map((item) => item.code), ["INVALID_JSON"]);

  const raw = structuredClone(contract) as unknown as Record<string, unknown>;
  const read = raw["designRead"] as Record<string, unknown>;
  read["moodboard"] = "default";
  assert.ok(codes(raw as unknown as CreativeContractV1).includes("UNKNOWN_KEY"));
  delete read["moodboard"];
  read["designSystem"] = "invented-ui";
  assert.ok(codes(raw as unknown as CreativeContractV1).includes("INVALID_VALUE"));
});

test("rejects the obsolete dialect observed in the live author response", () => {
  const current = validContract();
  const obsolete = {
    ...current,
    schemaVersion: "CreativeContractV1",
    dials: { expressiveness: 7, motionIntensity: 5, density: 5 },
    contentProof: current.contentProof.map(({ claim, allowedUses, ...proof }) => ({
      ...proof,
      text: claim,
      authorizedUses: allowedUses,
    })),
  };
  const result = compileCreativeContract(JSON.stringify(obsolete), RESOLVER);
  assert.equal(result.ok, false);
  const findings = new Set(result.errors.map((item) => `${item.code}:${item.path}`));
  assert.ok(findings.has("INVALID_VALUE:/schemaVersion"));
  assert.ok(findings.has("UNKNOWN_KEY:/dials/expressiveness"));
  assert.ok(findings.has("UNKNOWN_KEY:/dials/density"));
  assert.ok(findings.has("UNKNOWN_KEY:/contentProof/0/text"));
  assert.ok(findings.has("UNKNOWN_KEY:/contentProof/0/authorizedUses"));
});

test("rejects duplicate ids, dangling references, route coverage and route order drift", () => {
  const duplicate = mutableContract();
  duplicate.contentProof = [...duplicate.contentProof, duplicate.contentProof[0]!];
  assert.ok(codes(duplicate).includes("DUPLICATE_ID"));

  const dangling = mutableContract();
  dangling.sections[0]!.contentRefs[0]!.proofId = "missing";
  assert.ok(codes(dangling).includes("DANGLING_CONTENT_PROOF"));

  const coverage = mutableContract();
  coverage.routes[0]!.sectionIds = coverage.routes[0]!.sectionIds.slice(0, 2);
  assert.ok(codes(coverage).includes("DANGLING_SECTION"));

  const order = mutableContract();
  order.sections[1]!.order = 2;
  assert.ok(codes(order).includes("ROUTE_ORDER_INVALID"));

  const path = mutableContract();
  path.routes[1]!.path = "/";
  assert.ok(codes(path).includes("DUPLICATE_VALUE"));
});

test("requires resolvable evidence with exact source and excerpt digests", () => {
  assert.ok(codes(validContract(), { resolve: () => null }).includes("EVIDENCE_NOT_FOUND"));
  assert.ok(
    codes(validContract(), { resolve: () => ({ sha256: "f".repeat(64), excerptSha256: EXCERPT_HASH }) }).includes(
      "EVIDENCE_DIGEST_MISMATCH",
    ),
  );
});

test("enforces content-proof use coverage and authorization", () => {
  const unused = mutableContract();
  const unusedProof = proof("proof-unused");
  unused.contentProof.push({ ...unusedProof, evidence: { ...unusedProof.evidence }, allowedUses: [...unusedProof.allowedUses] });
  assert.ok(codes(unused).includes("CONTENT_PROOF_UNUSED"));

  const liveProofAudit = mutableContract();
  for (let index = liveProofAudit.contentProof.length; index <= 16; index += 1) {
    const extra = proof(`proof-live-${String(index)}`);
    liveProofAudit.contentProof.push({
      ...extra,
      evidence: { ...extra.evidence },
      allowedUses: [...extra.allowedUses],
    });
  }
  const liveProofResult = compile(liveProofAudit);
  assert.equal(liveProofResult.ok, false);
  assert.ok(liveProofResult.errors.some((item) =>
    item.code === "CONTENT_PROOF_UNUSED" && item.path === "/contentProof/16"));
  for (const extra of liveProofAudit.contentProof.slice(6)) {
    liveProofAudit.sections[1]!.contentRefs.push({ proofId: extra.id, use: "headline" });
  }
  assert.equal(compile(liveProofAudit).ok, true, "every retained proof compiles once a section references its id");

  const disallowedRef = mutableContract();
  disallowedRef.contentProof[0]!.allowedUses = ["action"];
  assert.ok(codes(disallowedRef).includes("CONTENT_USE_NOT_ALLOWED"));

  const disallowedAction = mutableContract();
  disallowedAction.contentProof[0]!.allowedUses = ["headline"];
  const actionResult = compile(disallowedAction);
  assert.equal(actionResult.ok, false);
  assert.ok(actionResult.errors.some((item) =>
    item.code === "CONTENT_USE_NOT_ALLOWED" && item.path === "/sections/0/actions/0/proofId"));

  const missingBody = mutableContract();
  missingBody.contentProof[1]!.allowedUses = ["body"];
  missingBody.sections[1]!.contentRefs[0]!.use = "body";
  const missingBodyResult = compile(missingBody);
  assert.equal(missingBodyResult.ok, false);
  assert.ok(missingBodyResult.errors.some((item) =>
    item.code === "CONTENT_USE_NOT_ALLOWED" && item.path === "/sections/1/contentRefs/0/use"));

  missingBody.sections[1]!.body = "The body now renders the admitted proof.";
  missingBody.sections[1]!.mobile.contentOrder = ["headline", "body", "visual"];
  assert.equal(compile(missingBody).ok, true, "a contentRef body use is valid once the body slot renders");
});

test("rejects generic copy and hero overflow/action failures", () => {
  const generic = mutableContract();
  generic.sections[0]!.headline = "Elevate your seamless workflow";
  assert.ok(codes(generic).includes("BANNED_COPY"));

  const longHero = mutableContract();
  longHero.sections[0]!.body = Array.from({ length: 21 }, () => "word").join(" ");
  longHero.sections[0]!.mobile.contentOrder = ["headline", "body", "visual", "actions"];
  assert.ok(codes(longHero).includes("HERO_BODY_TOO_LONG"));

  const headline = mutableContract();
  headline.sections[0]!.headline = "One line\nSecond line\nThird line";
  assert.ok(codes(headline).includes("HERO_HEADLINE_TOO_LONG"));

  const actions = mutableContract();
  actions.sections[0]!.actions = [
    ...actions.sections[0]!.actions,
    { id: "secondary", label: "Read details", intent: "learn_more", priority: "secondary", href: "/details", proofId: null },
    { id: "third", label: "View work", intent: "portfolio", priority: "secondary", href: "/work", proofId: null },
  ];
  assert.ok(codes(actions).includes("HERO_ACTION_LIMIT"));
});

test("enforces eyebrow cadence and rejects numbered eyebrow labels", () => {
  const cadence = mutableContract();
  cadence.sections[0]!.eyebrow = "Accountable runs";
  cadence.sections[0]!.mobile.contentOrder = ["eyebrow", "headline", "body", "visual", "actions"];
  cadence.sections[1]!.eyebrow = "Visible evidence";
  cadence.sections[1]!.mobile.contentOrder = ["eyebrow", "headline", "visual"];
  const cadenceCodes = codes(cadence);
  assert.ok(cadenceCodes.includes("EYEBROW_LIMIT"));
  assert.ok(cadenceCodes.includes("EYEBROW_SPACING"));

  const numbered = mutableContract();
  numbered.sections[1]!.eyebrow = "02 Capabilities";
  numbered.sections[1]!.mobile.contentOrder = ["eyebrow", "headline", "visual"];
  assert.ok(codes(numbered).includes("EYEBROW_NUMBERED"));
});

test("enforces one action label per intent and destination and one primary action per section", () => {
  const drift = mutableContract();
  drift.sections[3]!.actions = [{ id: "work-start", label: "Get started", intent: "signup", priority: "primary", href: "/start", proofId: null }];
  drift.sections[3]!.mobile.contentOrder = ["headline", "visual", "actions"];
  assert.ok(codes(drift).includes("ACTION_INTENT_LABEL_DRIFT"));

  const primary = mutableContract();
  primary.sections[0]!.actions = [
    ...primary.sections[0]!.actions,
    { id: "other-primary", label: "Read details", intent: "learn_more", priority: "primary", href: "/details", proofId: null },
  ];
  assert.ok(codes(primary).includes("ACTION_PRIMARY_LIMIT"));
});

test("accepts the live destination-specific action matrix and four-word case-study CTA", () => {
  const live = mutableContract();
  live.sections[1]!.actions = [
    { id: "services", label: "Our Services", intent: "navigate", priority: "secondary", href: "/services", proofId: null },
    { id: "approach", label: "Our Approach", intent: "navigate", priority: "secondary", href: "/approach", proofId: null },
    { id: "cases", label: "Case Studies", intent: "navigate", priority: "secondary", href: "/case-studies", proofId: null },
  ];
  live.sections[1]!.mobile.contentOrder = ["headline", "visual", "actions"];
  live.sections[2]!.actions = [
    { id: "privacy", label: "Privacy", intent: "navigate", priority: "secondary", href: "/privacy", proofId: null },
    { id: "cookies", label: "Cookies", intent: "navigate", priority: "secondary", href: "/cookies", proofId: null },
    { id: "linkedin", label: "LinkedIn", intent: "navigate", priority: "secondary", href: "https://linkedin.com/company/example", proofId: null },
  ];
  live.sections[2]!.mobile.contentOrder = ["headline", "actions"];
  live.sections[4]!.actions = [
    { id: "readiness", label: "Run readiness check", intent: "learn_more", priority: "secondary", href: "#readiness", proofId: null },
    { id: "solutions", label: "Explore our solutions", intent: "learn_more", priority: "secondary", href: "/services", proofId: null },
    { id: "case-study", label: "Read the case study", intent: "learn_more", priority: "secondary", href: "/case-studies/example", proofId: null },
  ];
  live.sections[4]!.mobile.contentOrder = ["headline", "visual", "actions"];

  assert.equal(compile(live).ok, true, "unrelated destinations need specific labels even within one broad intent");

  const sameDestination = structuredClone(live);
  sameDestination.sections[2]!.actions.push({
    id: "services-again", label: "Our Services", intent: "navigate", priority: "secondary", href: " /services ", proofId: null,
  });
  assert.equal(compile(sameDestination).ok, true, "the same intent and trimmed destination may repeat the same label");

  const drift = structuredClone(sameDestination);
  drift.sections[2]!.actions[3]!.label = "Services";
  const driftResult = compile(drift);
  assert.equal(driftResult.ok, false);
  assert.ok(driftResult.errors.some((item) =>
    item.code === "ACTION_INTENT_LABEL_DRIFT" && item.path === "/sections/2/actions/3/label"));

  const long = structuredClone(live);
  long.sections[4]!.actions[2]!.label = "Read the complete case study";
  const longResult = compile(long);
  assert.equal(longResult.ok, false);
  assert.ok(longResult.errors.some((item) =>
    item.code === "LIMIT_EXCEEDED" && item.path === "/sections/4/actions/2/label"));
});

test("enforces layout diversity, zigzag and marquee rules", () => {
  const repeated = mutableContract();
  repeated.sections[1]!.layoutFamily = "asymmetric_split";
  assert.ok(codes(repeated).includes("LAYOUT_FAMILY_REPEATED"));

  const zigzag = mutableContract();
  zigzag.sections[0]!.layoutFamily = "split_media_left";
  zigzag.sections[1]!.layoutFamily = "split_media_right";
  zigzag.sections[2]!.layoutFamily = "split_media_left";
  zigzag.sections[2]!.mobile = { strategy: "stack", contentOrder: ["headline"] };
  assert.ok(codes(zigzag).includes("ZIGZAG_LIMIT"));

  const marquee = mutableContract();
  marquee.sections[0]!.layoutFamily = "marquee";
  marquee.sections[1]!.layoutFamily = "marquee";
  assert.ok(codes(marquee).includes("MARQUEE_LIMIT"));
});

test("requires complete mobile ordering and collapse for multi-column layouts", () => {
  const order = mutableContract();
  order.sections[0]!.mobile.contentOrder = ["headline", "actions"];
  assert.ok(codes(order).includes("MOBILE_ORDER_INVALID"));

  const collapse = mutableContract();
  collapse.sections[1]!.mobile.strategy = "preserve";
  assert.ok(codes(collapse).includes("MOBILE_COLLAPSE_REQUIRED"));
});

test("enforces motion dials, safe properties, fallback authorization and UI simulation", () => {
  const dial = mutableContract();
  dial.dials.motionIntensity = 3;
  dial.motion[0]!.trigger = "scroll_progress";
  assert.ok(codes(dial).includes("MOTION_DIAL_CONFLICT"));

  const ui = mutableContract();
  ui.motion[0]!.sourceStillKind = "ui";
  assert.ok(codes(ui).includes("UI_SIMULATION_UNAUTHORIZED"));

  const liveUiPaths = mutableContract();
  for (let index = 2; index <= 5; index += 1) {
    const template = structuredClone(liveUiPaths.motion[index % 2]!);
    liveUiPaths.motion.push({ ...template, id: `live-motion-${String(index)}` });
  }
  liveUiPaths.motion[4]!.sourceStillKind = "ui";
  liveUiPaths.motion[5]!.sourceStillKind = "ui";
  const liveUiResult = compile(liveUiPaths);
  assert.equal(liveUiResult.ok, false);
  assert.deepEqual(
    liveUiResult.errors
      .filter((item) => item.code === "UI_SIMULATION_UNAUTHORIZED")
      .map((item) => item.path),
    ["/motion/4/simulationAuthorized", "/motion/5/simulationAuthorized"],
  );

  const authorizedUi = structuredClone(liveUiPaths);
  authorizedUi.motion[4]!.simulationAuthorized = true;
  authorizedUi.motion[5]!.simulationAuthorized = true;
  assert.equal(compile(authorizedUi).ok, true, "UI still simulation passes when simulationAuthorized is true");

  const absent = mutableContract();
  absent.motion = [];
  assert.ok(codes(absent).includes("MOTION_REQUIRED"));
});

test("accepts a used scoped exception and rejects absent, dangling and unused exceptions", () => {
  const centered = mutableContract();
  centered.sections[0]!.layoutFamily = "centered_hero";
  assert.ok(codes(centered).includes("EXCEPTION_REQUIRED"));
  centered.intentionalExceptions = [{ rule: "CENTERED_HERO", routeId: "home", sectionIds: ["home-hero"], rationale: "The owner chose a ceremonial single-action launch composition.", evidence: EVIDENCE }];
  const accepted = compile(centered);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const dangling = mutableContract();
  dangling.intentionalExceptions = [{ rule: "CENTERED_HERO", routeId: "missing", sectionIds: ["home-hero"], rationale: "Owner-approved direction.", evidence: EVIDENCE }];
  assert.ok(codes(dangling).includes("DANGLING_ROUTE"));

  const global = mutableContract();
  global.designRead.displayStyle = "serif";
  global.intentionalExceptions = [{ rule: "SERIF_DISPLAY", routeId: null, sectionIds: [], rationale: "Owner-approved typography.", evidence: EVIDENCE }];
  assert.equal(compile(global).ok, true, "an active global rule accepts null routeId and empty sectionIds");

  const liveEditorialSerif = mutableContract();
  liveEditorialSerif.designRead.pageKind = "agency_landing";
  liveEditorialSerif.designRead.aestheticFamily = "editorial";
  liveEditorialSerif.designRead.displayStyle = "serif";
  liveEditorialSerif.intentionalExceptions = [{ rule: "SERIF_DISPLAY", routeId: null, sectionIds: [], rationale: "Editorial typography.", evidence: EVIDENCE }];
  const liveEditorialResult = compile(liveEditorialSerif);
  assert.equal(liveEditorialResult.ok, false);
  assert.ok(liveEditorialResult.errors.some((item) =>
    item.code === "EXCEPTION_UNUSED" && item.path === "/intentionalExceptions/0"));
  liveEditorialSerif.intentionalExceptions = [];
  assert.equal(compile(liveEditorialSerif).ok, true, "editorial aesthetic makes the serif exception unnecessary");

  const wrongScope = structuredClone(global);
  wrongScope.intentionalExceptions[0]!.routeId = "home";
  wrongScope.intentionalExceptions[0]!.sectionIds = ["home-hero"];
  const wrongScopeResult = compile(wrongScope);
  assert.equal(wrongScopeResult.ok, false);
  assert.ok(wrongScopeResult.errors.some((item) =>
    item.code === "EXCEPTION_SCOPE_INVALID" && item.path === "/intentionalExceptions/0"));

  const unused = mutableContract();
  unused.intentionalExceptions = [{ rule: "SERIF_DISPLAY", routeId: null, sectionIds: [], rationale: "Owner-approved typography.", evidence: EVIDENCE }];
  const unusedResult = compile(unused);
  assert.equal(unusedResult.ok, false);
  assert.ok(unusedResult.errors.some((item) =>
    item.code === "EXCEPTION_UNUSED" && item.path === "/intentionalExceptions/0"));
});
