import { strict as assert } from "node:assert";
import { test } from "node:test";

import { compileCreativeContract } from "./creative-contract.js";
import type { CreativeContractV1, CreativeEvidenceRef, CreativeEvidenceResolver, CreativeSectionV1 } from "./creative-contract.js";

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

  const disallowed = mutableContract();
  disallowed.contentProof[0]!.allowedUses = ["action"];
  assert.ok(codes(disallowed).includes("CONTENT_USE_NOT_ALLOWED"));
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

test("enforces one action label per intent and one primary action per section", () => {
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

  const unused = mutableContract();
  unused.intentionalExceptions = [{ rule: "SERIF_DISPLAY", routeId: null, sectionIds: [], rationale: "Owner-approved typography.", evidence: EVIDENCE }];
  assert.ok(codes(unused).includes("EXCEPTION_UNUSED"));
});
