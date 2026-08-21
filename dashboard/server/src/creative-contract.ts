import { createHash } from "node:crypto";

export const CREATIVE_CONTRACT_SCHEMA_VERSION = 1 as const;
export const MAX_CREATIVE_ROUTES = 20;
export const MAX_CREATIVE_SECTIONS = 80;
export const MAX_CONTENT_PROOFS = 200;
export const MAX_CREATIVE_MOTIONS = 80;
export const MAX_CREATIVE_EXCEPTIONS = 20;
export const MAX_ACTION_LABEL_WORDS = 4;

export const PAGE_KINDS = ["saas_landing", "consumer_landing", "agency_landing", "event_landing", "portfolio", "editorial"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const AESTHETIC_FAMILIES = ["minimal", "editorial", "industrial", "playful", "premium", "trust_first", "brand_defined"] as const;
export type AestheticFamily = (typeof AESTHETIC_FAMILIES)[number];

export const DESIGN_SYSTEMS = ["native", "tailwind", "radix", "shadcn", "material", "fluent", "carbon", "polaris", "atlaskit", "primer", "govuk", "uswds", "bootstrap"] as const;
export type DesignSystem = (typeof DESIGN_SYSTEMS)[number];

export const DISPLAY_STYLES = ["sans", "serif"] as const;
export type DisplayStyle = (typeof DISPLAY_STYLES)[number];

export const PALETTE_FAMILIES = ["brand", "neutral_pop", "cold_luxury", "forest", "black_tan", "cobalt_cream", "terracotta_slate", "olive_brick_paper", "warm_craft", "purple", "custom"] as const;
export type PaletteFamily = (typeof PALETTE_FAMILIES)[number];

export const THEME_BEHAVIORS = ["light", "dark", "auto", "section_switch"] as const;
export type ThemeBehavior = (typeof THEME_BEHAVIORS)[number];

export const CONTENT_PROOF_STATUSES = ["verbatim", "supported_paraphrase", "owner_required", "explicit_mock"] as const;
export type ContentProofStatus = (typeof CONTENT_PROOF_STATUSES)[number];

export const CONTENT_USES = ["eyebrow", "headline", "body", "action", "alt", "metric", "quote"] as const;
export type ContentUse = (typeof CONTENT_USES)[number];

export const EVIDENCE_KINDS = ["owner_message", "brief_artifact", "repository_artifact", "render_observation"] as const;
export type CreativeEvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const SECTION_KINDS = ["hero", "navigation", "feature", "proof", "gallery", "pricing", "quote", "form", "cta", "footer", "editorial"] as const;
export type CreativeSectionKind = (typeof SECTION_KINDS)[number];

export const LAYOUT_FAMILIES = ["centered_hero", "asymmetric_split", "editorial_manifesto", "media_mask", "kinetic_type", "split_media_left", "split_media_right", "bento", "masonry", "vertical_stack", "logo_wall", "full_width_quote", "sticky_stack", "horizontal_pan", "marquee", "gallery_grid", "pricing_columns", "form_stack", "navigation_bar", "footer_columns"] as const;
export type LayoutFamily = (typeof LAYOUT_FAMILIES)[number];

export const VISUAL_KINDS = ["generated_image", "brand_asset", "licensed_image", "real_component", "video", "type_only", "none"] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

export const ACTION_INTENTS = ["contact", "signup", "purchase", "download", "navigate", "portfolio", "learn_more"] as const;
export type ActionIntent = (typeof ACTION_INTENTS)[number];
export const ACTION_PRIORITIES = ["primary", "secondary"] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

export const MOBILE_STRATEGIES = ["stack", "preserve", "horizontal_scroll", "hide_decorative"] as const;
export type MobileStrategy = (typeof MOBILE_STRATEGIES)[number];
export const MOBILE_CONTENT_SLOTS = ["eyebrow", "headline", "body", "visual", "actions"] as const;
export type MobileContentSlot = (typeof MOBILE_CONTENT_SLOTS)[number];

export const REQUIRED_RENDER_STATES = ["default", "loading", "empty", "error", "interaction"] as const;
export type RequiredRenderState = (typeof REQUIRED_RENDER_STATES)[number];

export const MOTION_PURPOSES = ["hierarchy", "storytelling", "feedback", "state_transition"] as const;
export type MotionPurpose = (typeof MOTION_PURPOSES)[number];
export const MOTION_TRIGGERS = ["load", "enter_view", "interaction", "scroll_progress"] as const;
export type MotionTrigger = (typeof MOTION_TRIGGERS)[number];
export const MOTION_IMPLEMENTATIONS = ["css", "motion", "gsap", "native_scroll"] as const;
export type MotionImplementation = (typeof MOTION_IMPLEMENTATIONS)[number];
export const MOTION_PROPERTIES = ["opacity", "transform"] as const;
export type MotionProperty = (typeof MOTION_PROPERTIES)[number];
export const REDUCED_MOTION_FALLBACKS = ["static", "instant", "content_equivalent"] as const;
export type ReducedMotionFallback = (typeof REDUCED_MOTION_FALLBACKS)[number];
export const NO_MEDIA_FALLBACKS = ["static_asset", "content_equivalent", "not_applicable"] as const;
export type NoMediaFallback = (typeof NO_MEDIA_FALLBACKS)[number];
export const SOURCE_STILL_KINDS = ["none", "illustration", "ui"] as const;
export type SourceStillKind = (typeof SOURCE_STILL_KINDS)[number];

export const INTENTIONAL_EXCEPTION_RULES = ["CENTERED_HERO", "SERIF_DISPLAY", "PURPLE_PALETTE", "WARM_CRAFT_PALETTE", "THEME_SWITCH", "LAYOUT_FAMILY_REPEAT", "SECOND_MARQUEE", "TEXT_ONLY_PAGE", "DIAL_DEVIATION"] as const;
export type IntentionalExceptionRule = (typeof INTENTIONAL_EXCEPTION_RULES)[number];

export interface CreativeEvidenceRef {
  readonly kind: CreativeEvidenceKind;
  readonly locator: string;
  readonly sha256: string;
  readonly excerptSha256: string;
}

export interface CreativeEvidenceResolution {
  readonly sha256: string;
  readonly excerptSha256: string;
}

export interface CreativeEvidenceResolver {
  resolve(reference: CreativeEvidenceRef): CreativeEvidenceResolution | null;
}

export interface ContentProofV1 {
  readonly id: string;
  readonly claim: string;
  readonly status: ContentProofStatus;
  readonly evidence: CreativeEvidenceRef;
  readonly allowedUses: readonly ContentUse[];
}

export interface SectionContentRefV1 {
  readonly proofId: string;
  readonly use: ContentUse;
}

export interface CreativeActionV1 {
  readonly id: string;
  readonly label: string;
  readonly intent: ActionIntent;
  readonly priority: ActionPriority;
  readonly href: string;
  readonly proofId: string | null;
}

export interface MobilePlanV1 {
  readonly strategy: MobileStrategy;
  readonly contentOrder: readonly MobileContentSlot[];
}

export interface CreativeSectionV1 {
  readonly id: string;
  readonly routeId: string;
  readonly order: number;
  readonly kind: CreativeSectionKind;
  readonly job: string;
  readonly contentRefs: readonly SectionContentRefV1[];
  readonly eyebrow: string | null;
  readonly headline: string;
  readonly body: string | null;
  readonly actions: readonly CreativeActionV1[];
  readonly layoutFamily: LayoutFamily;
  readonly visualKind: VisualKind;
  readonly mobile: MobilePlanV1;
  readonly requiredStates: readonly RequiredRenderState[];
}

export interface CreativeRouteV1 {
  readonly id: string;
  readonly path: string;
  readonly sectionIds: readonly string[];
}

export interface CreativeMotionV1 {
  readonly id: string;
  readonly routeId: string;
  readonly sectionId: string;
  readonly target: string;
  readonly purpose: MotionPurpose;
  readonly trigger: MotionTrigger;
  readonly implementation: MotionImplementation;
  readonly properties: readonly MotionProperty[];
  readonly rationale: string;
  readonly fallback: {
    readonly reducedMotion: ReducedMotionFallback;
    readonly noMedia: NoMediaFallback;
  };
  readonly sourceStillKind: SourceStillKind;
  readonly simulationAuthorized: boolean;
}

export interface IntentionalExceptionV1 {
  readonly rule: IntentionalExceptionRule;
  readonly routeId: string | null;
  readonly sectionIds: readonly string[];
  readonly rationale: string;
  readonly evidence: CreativeEvidenceRef;
}

export interface CreativeContractV1 {
  readonly schemaVersion: typeof CREATIVE_CONTRACT_SCHEMA_VERSION;
  readonly contractId: string;
  readonly designRead: {
    readonly pageKind: PageKind;
    readonly audience: string;
    readonly vibe: string;
    readonly aestheticFamily: AestheticFamily;
    readonly designSystem: DesignSystem;
    readonly displayStyle: DisplayStyle;
    readonly paletteFamily: PaletteFamily;
    readonly theme: ThemeBehavior;
    readonly thesis: string;
  };
  readonly dials: {
    readonly designVariance: number;
    readonly motionIntensity: number;
    readonly visualDensity: number;
  };
  readonly contentProof: readonly ContentProofV1[];
  readonly routes: readonly CreativeRouteV1[];
  readonly sections: readonly CreativeSectionV1[];
  readonly motion: readonly CreativeMotionV1[];
  readonly intentionalExceptions: readonly IntentionalExceptionV1[];
}

type JsonSchema = Readonly<Record<string, unknown>>;

function closedSchema(
  properties: Readonly<Record<string, JsonSchema>>,
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function textSchema(maxLength: number, pattern = "\\S"): JsonSchema {
  return { type: "string", minLength: 1, maxLength, pattern };
}

function nullableTextSchema(maxLength: number, pattern = "\\S"): JsonSchema {
  return { type: ["string", "null"], minLength: 1, maxLength, pattern };
}

function enumSchema(values: readonly string[]): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 64, enum: values };
}

function arrayEnumSchema(values: readonly string[]): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 128, enum: values };
}

function arraySchema(items: JsonSchema, minItems: number, maxItems: number, uniqueItems = false): JsonSchema {
  return { type: "array", items, minItems, maxItems, ...(uniqueItems ? { uniqueItems: true } : {}) };
}

const ID_SCHEMA = textSchema(128, "^[A-Za-z0-9][A-Za-z0-9._:-]*$");
const NULLABLE_ID_SCHEMA = nullableTextSchema(128, "^[A-Za-z0-9][A-Za-z0-9._:-]*$");
const HASH_SCHEMA = textSchema(64, "^[a-f0-9]{64}$");
const EVIDENCE_SCHEMA = closedSchema({
  kind: enumSchema(EVIDENCE_KINDS),
  locator: textSchema(512),
  sha256: HASH_SCHEMA,
  excerptSha256: HASH_SCHEMA,
});
const CONTENT_REF_SCHEMA = closedSchema({
  proofId: ID_SCHEMA,
  use: enumSchema(CONTENT_USES),
});
const ACTION_SCHEMA = closedSchema({
  id: ID_SCHEMA,
  label: textSchema(60),
  intent: enumSchema(ACTION_INTENTS),
  priority: enumSchema(ACTION_PRIORITIES),
  href: textSchema(512),
  proofId: NULLABLE_ID_SCHEMA,
});
const MOBILE_SCHEMA = closedSchema({
  strategy: enumSchema(MOBILE_STRATEGIES),
  contentOrder: arraySchema(arrayEnumSchema(MOBILE_CONTENT_SLOTS), 1, MOBILE_CONTENT_SLOTS.length, true),
});
const MOTION_FALLBACK_SCHEMA = closedSchema({
  reducedMotion: enumSchema(REDUCED_MOTION_FALLBACKS),
  noMedia: enumSchema(NO_MEDIA_FALLBACKS),
});

/**
 * Structured-output boundary for the model author. The deterministic compiler
 * below remains authoritative for cross-reference and semantic rules; this
 * schema prevents the seat from inventing a different structural dialect.
 */
export const CREATIVE_CONTRACT_V1_JSON_SCHEMA: JsonSchema = Object.freeze(closedSchema({
  schemaVersion: { type: "integer", const: CREATIVE_CONTRACT_SCHEMA_VERSION },
  contractId: ID_SCHEMA,
  designRead: closedSchema({
    pageKind: enumSchema(PAGE_KINDS),
    audience: textSchema(300),
    vibe: textSchema(200),
    aestheticFamily: enumSchema(AESTHETIC_FAMILIES),
    designSystem: enumSchema(DESIGN_SYSTEMS),
    displayStyle: enumSchema(DISPLAY_STYLES),
    paletteFamily: enumSchema(PALETTE_FAMILIES),
    theme: enumSchema(THEME_BEHAVIORS),
    thesis: textSchema(500),
  }),
  dials: closedSchema({
    designVariance: { type: "integer", minimum: 1, maximum: 10 },
    motionIntensity: { type: "integer", minimum: 1, maximum: 10 },
    visualDensity: { type: "integer", minimum: 1, maximum: 10 },
  }),
  contentProof: arraySchema(closedSchema({
    id: ID_SCHEMA,
    claim: textSchema(800),
    status: enumSchema(CONTENT_PROOF_STATUSES),
    evidence: EVIDENCE_SCHEMA,
    allowedUses: arraySchema(arrayEnumSchema(CONTENT_USES), 1, CONTENT_USES.length, true),
  }), 1, MAX_CONTENT_PROOFS),
  routes: arraySchema(closedSchema({
    id: ID_SCHEMA,
    path: textSchema(256, "^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?$"),
    sectionIds: arraySchema(ID_SCHEMA, 1, MAX_CREATIVE_SECTIONS, true),
  }), 1, MAX_CREATIVE_ROUTES),
  sections: arraySchema(closedSchema({
    id: ID_SCHEMA,
    routeId: ID_SCHEMA,
    order: { type: "integer", minimum: 0, maximum: MAX_CREATIVE_SECTIONS - 1 },
    kind: enumSchema(SECTION_KINDS),
    job: textSchema(400),
    contentRefs: arraySchema(CONTENT_REF_SCHEMA, 1, 20),
    eyebrow: nullableTextSchema(80),
    headline: textSchema(160),
    body: nullableTextSchema(500),
    actions: arraySchema(ACTION_SCHEMA, 0, 4),
    layoutFamily: enumSchema(LAYOUT_FAMILIES),
    visualKind: enumSchema(VISUAL_KINDS),
    mobile: MOBILE_SCHEMA,
    requiredStates: arraySchema(arrayEnumSchema(REQUIRED_RENDER_STATES), 1, REQUIRED_RENDER_STATES.length, true),
  }), 1, MAX_CREATIVE_SECTIONS),
  motion: arraySchema(closedSchema({
    id: ID_SCHEMA,
    routeId: ID_SCHEMA,
    sectionId: ID_SCHEMA,
    target: textSchema(200),
    purpose: enumSchema(MOTION_PURPOSES),
    trigger: enumSchema(MOTION_TRIGGERS),
    implementation: enumSchema(MOTION_IMPLEMENTATIONS),
    properties: arraySchema(arrayEnumSchema(MOTION_PROPERTIES), 1, MOTION_PROPERTIES.length, true),
    rationale: textSchema(400),
    fallback: MOTION_FALLBACK_SCHEMA,
    sourceStillKind: enumSchema(SOURCE_STILL_KINDS),
    simulationAuthorized: { type: "boolean" },
  }), 0, MAX_CREATIVE_MOTIONS),
  intentionalExceptions: arraySchema(closedSchema({
    rule: enumSchema(INTENTIONAL_EXCEPTION_RULES),
    routeId: NULLABLE_ID_SCHEMA,
    sectionIds: arraySchema(ID_SCHEMA, 0, 8, true),
    rationale: textSchema(400),
    evidence: EVIDENCE_SCHEMA,
  }), 0, MAX_CREATIVE_EXCEPTIONS),
}));

export type CreativeCompilerConstraint =
  | { readonly type: "object"; readonly required: readonly string[]; readonly additionalProperties: false }
  | { readonly type: "array"; readonly minItems: number; readonly maxItems: number; readonly uniqueItems: boolean }
  | {
      readonly type: "string"; readonly nullable: boolean; readonly minLength: number; readonly maxLength: number;
      readonly pattern: string | null; readonly enum: readonly string[] | null;
    }
  | { readonly type: "integer"; readonly minimum: number | null; readonly maximum: number | null; readonly constValue: number | null }
  | { readonly type: "boolean" };

const compilerObject = (...required: readonly string[]): CreativeCompilerConstraint =>
  ({ type: "object", required, additionalProperties: false });
const compilerArray = (minItems: number, maxItems: number, uniqueItems = false): CreativeCompilerConstraint =>
  ({ type: "array", minItems, maxItems, uniqueItems });
const compilerString = (
  maxLength: number,
  options: { readonly nullable?: boolean; readonly pattern?: string; readonly enum?: readonly string[] } = {},
): CreativeCompilerConstraint => ({
  type: "string", nullable: options.nullable === true, minLength: 1, maxLength,
  pattern: options.pattern ?? (options.enum === undefined ? "\\S" : null), enum: options.enum ?? null,
});
const compilerEnum = (values: readonly string[], maxLength = 64): CreativeCompilerConstraint =>
  compilerString(maxLength, { enum: values });
const compilerInteger = (minimum: number | null, maximum: number | null, constValue: number | null = null): CreativeCompilerConstraint =>
  ({ type: "integer", minimum, maximum, constValue });

const compilerEvidence = (prefix: string): Readonly<Record<string, CreativeCompilerConstraint>> => ({
  [prefix]: compilerObject("kind", "locator", "sha256", "excerptSha256"),
  [`${prefix}/kind`]: compilerEnum(EVIDENCE_KINDS),
  [`${prefix}/locator`]: compilerString(512),
  [`${prefix}/sha256`]: compilerString(64, { pattern: "^[a-f0-9]{64}$" }),
  [`${prefix}/excerptSha256`]: compilerString(64, { pattern: "^[a-f0-9]{64}$" }),
});

/**
 * Compiler-owned structural manifest. Unlike the author schema, this table is
 * intentionally flat and names every compiler constraint so parity tests run in
 * both directions: deleting a schema constraint cannot delete its own test.
 */
export const CREATIVE_CONTRACT_V1_COMPILER_CONSTRAINTS: Readonly<Record<string, CreativeCompilerConstraint>> = Object.freeze({
  "/": compilerObject("schemaVersion", "contractId", "designRead", "dials", "contentProof", "routes", "sections", "motion", "intentionalExceptions"),
  "/schemaVersion": compilerInteger(null, null, CREATIVE_CONTRACT_SCHEMA_VERSION),
  "/contractId": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/designRead": compilerObject("pageKind", "audience", "vibe", "aestheticFamily", "designSystem", "displayStyle", "paletteFamily", "theme", "thesis"),
  "/designRead/pageKind": compilerEnum(PAGE_KINDS),
  "/designRead/audience": compilerString(300),
  "/designRead/vibe": compilerString(200),
  "/designRead/aestheticFamily": compilerEnum(AESTHETIC_FAMILIES),
  "/designRead/designSystem": compilerEnum(DESIGN_SYSTEMS),
  "/designRead/displayStyle": compilerEnum(DISPLAY_STYLES),
  "/designRead/paletteFamily": compilerEnum(PALETTE_FAMILIES),
  "/designRead/theme": compilerEnum(THEME_BEHAVIORS),
  "/designRead/thesis": compilerString(500),
  "/dials": compilerObject("designVariance", "motionIntensity", "visualDensity"),
  "/dials/designVariance": compilerInteger(1, 10),
  "/dials/motionIntensity": compilerInteger(1, 10),
  "/dials/visualDensity": compilerInteger(1, 10),
  "/contentProof": compilerArray(1, MAX_CONTENT_PROOFS),
  "/contentProof/*": compilerObject("id", "claim", "status", "evidence", "allowedUses"),
  "/contentProof/*/id": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/contentProof/*/claim": compilerString(800),
  "/contentProof/*/status": compilerEnum(CONTENT_PROOF_STATUSES),
  ...compilerEvidence("/contentProof/*/evidence"),
  "/contentProof/*/allowedUses": compilerArray(1, CONTENT_USES.length, true),
  "/contentProof/*/allowedUses/*": compilerEnum(CONTENT_USES, 128),
  "/routes": compilerArray(1, MAX_CREATIVE_ROUTES),
  "/routes/*": compilerObject("id", "path", "sectionIds"),
  "/routes/*/id": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/routes/*/path": compilerString(256, { pattern: "^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?$" }),
  "/routes/*/sectionIds": compilerArray(1, MAX_CREATIVE_SECTIONS, true),
  "/routes/*/sectionIds/*": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/sections": compilerArray(1, MAX_CREATIVE_SECTIONS),
  "/sections/*": compilerObject("id", "routeId", "order", "kind", "job", "contentRefs", "eyebrow", "headline", "body", "actions", "layoutFamily", "visualKind", "mobile", "requiredStates"),
  "/sections/*/id": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/sections/*/routeId": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/sections/*/order": compilerInteger(0, MAX_CREATIVE_SECTIONS - 1),
  "/sections/*/kind": compilerEnum(SECTION_KINDS),
  "/sections/*/job": compilerString(400),
  "/sections/*/contentRefs": compilerArray(1, 20),
  "/sections/*/contentRefs/*": compilerObject("proofId", "use"),
  "/sections/*/contentRefs/*/proofId": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/sections/*/contentRefs/*/use": compilerEnum(CONTENT_USES),
  "/sections/*/eyebrow": compilerString(80, { nullable: true }),
  "/sections/*/headline": compilerString(160),
  "/sections/*/body": compilerString(500, { nullable: true }),
  "/sections/*/actions": compilerArray(0, 4),
  "/sections/*/actions/*": compilerObject("id", "label", "intent", "priority", "href", "proofId"),
  "/sections/*/actions/*/id": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/sections/*/actions/*/label": compilerString(60),
  "/sections/*/actions/*/intent": compilerEnum(ACTION_INTENTS),
  "/sections/*/actions/*/priority": compilerEnum(ACTION_PRIORITIES),
  "/sections/*/actions/*/href": compilerString(512),
  "/sections/*/actions/*/proofId": compilerString(128, { nullable: true, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/sections/*/layoutFamily": compilerEnum(LAYOUT_FAMILIES),
  "/sections/*/visualKind": compilerEnum(VISUAL_KINDS),
  "/sections/*/mobile": compilerObject("strategy", "contentOrder"),
  "/sections/*/mobile/strategy": compilerEnum(MOBILE_STRATEGIES),
  "/sections/*/mobile/contentOrder": compilerArray(1, MOBILE_CONTENT_SLOTS.length, true),
  "/sections/*/mobile/contentOrder/*": compilerEnum(MOBILE_CONTENT_SLOTS, 128),
  "/sections/*/requiredStates": compilerArray(1, REQUIRED_RENDER_STATES.length, true),
  "/sections/*/requiredStates/*": compilerEnum(REQUIRED_RENDER_STATES, 128),
  "/motion": compilerArray(0, MAX_CREATIVE_MOTIONS),
  "/motion/*": compilerObject("id", "routeId", "sectionId", "target", "purpose", "trigger", "implementation", "properties", "rationale", "fallback", "sourceStillKind", "simulationAuthorized"),
  "/motion/*/id": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/motion/*/routeId": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/motion/*/sectionId": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/motion/*/target": compilerString(200),
  "/motion/*/purpose": compilerEnum(MOTION_PURPOSES),
  "/motion/*/trigger": compilerEnum(MOTION_TRIGGERS),
  "/motion/*/implementation": compilerEnum(MOTION_IMPLEMENTATIONS),
  "/motion/*/properties": compilerArray(1, MOTION_PROPERTIES.length, true),
  "/motion/*/properties/*": compilerEnum(MOTION_PROPERTIES, 128),
  "/motion/*/rationale": compilerString(400),
  "/motion/*/fallback": compilerObject("reducedMotion", "noMedia"),
  "/motion/*/fallback/reducedMotion": compilerEnum(REDUCED_MOTION_FALLBACKS),
  "/motion/*/fallback/noMedia": compilerEnum(NO_MEDIA_FALLBACKS),
  "/motion/*/sourceStillKind": compilerEnum(SOURCE_STILL_KINDS),
  "/motion/*/simulationAuthorized": { type: "boolean" },
  "/intentionalExceptions": compilerArray(0, MAX_CREATIVE_EXCEPTIONS),
  "/intentionalExceptions/*": compilerObject("rule", "routeId", "sectionIds", "rationale", "evidence"),
  "/intentionalExceptions/*/rule": compilerEnum(INTENTIONAL_EXCEPTION_RULES),
  "/intentionalExceptions/*/routeId": compilerString(128, { nullable: true, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/intentionalExceptions/*/sectionIds": compilerArray(0, 8, true),
  "/intentionalExceptions/*/sectionIds/*": compilerString(128, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  "/intentionalExceptions/*/rationale": compilerString(400),
  ...compilerEvidence("/intentionalExceptions/*/evidence"),
});

export type CreativeCompileErrorCode =
  | "INVALID_JSON" | "INVALID_ROOT" | "UNKNOWN_KEY" | "MISSING_KEY" | "INVALID_TYPE" | "INVALID_VALUE" | "LIMIT_EXCEEDED"
  | "DUPLICATE_ID" | "DUPLICATE_VALUE" | "DANGLING_ROUTE" | "DANGLING_SECTION" | "DANGLING_CONTENT_PROOF"
  | "EVIDENCE_NOT_FOUND" | "EVIDENCE_DIGEST_MISMATCH" | "CONTENT_PROOF_UNUSED" | "CONTENT_USE_NOT_ALLOWED"
  | "BANNED_COPY" | "HERO_MISSING" | "HERO_MULTIPLE" | "HERO_ORDER" | "HERO_BODY_TOO_LONG" | "HERO_ACTION_LIMIT"
  | "HERO_HEADLINE_TOO_LONG" | "HERO_PRIMARY_ACTION_INVALID" | "EYEBROW_LIMIT" | "EYEBROW_SPACING" | "EYEBROW_NUMBERED" | "ACTION_PRIMARY_LIMIT"
  | "ACTION_INTENT_LABEL_DRIFT" | "LAYOUT_FAMILY_REPEATED" | "LAYOUT_FAMILY_COVERAGE" | "ZIGZAG_LIMIT" | "MARQUEE_LIMIT"
  | "ROUTE_ORDER_INVALID" | "MOBILE_ORDER_INVALID" | "MOBILE_COLLAPSE_REQUIRED" | "MOTION_DIAL_CONFLICT" | "MOTION_REQUIRED"
  | "MOTION_PROPERTY_FORBIDDEN" | "MOTION_FALLBACK_INVALID" | "UI_SIMULATION_UNAUTHORIZED" | "EXCEPTION_SCOPE_INVALID"
  | "EXCEPTION_REQUIRED" | "EXCEPTION_UNUSED" | "VISUAL_REQUIRED";

/**
 * Semantic constraints the author must satisfy before the deterministic
 * compiler sees its first draft. Kept with the compiler so prompt wording does
 * not independently reinterpret these branches.
 */
export const CREATIVE_CONTRACT_V1_AUTHOR_INVARIANTS = [
  {
    id: "content-proof-coverage",
    errorSites: [{ code: "CONTENT_PROOF_UNUSED", pathPattern: "/contentProof/*" }],
    guidance:
      "Before output, audit every contentProof id: each id must appear in at least one sections[].contentRefs[].proofId or actions[].proofId; omit every unreferenced contentProof entry.",
  },
  {
    id: "action-labels",
    errorSites: [
      { code: "LIMIT_EXCEEDED", pathPattern: "/sections/*/actions/*/label" },
      { code: "ACTION_INTENT_LABEL_DRIFT", pathPattern: "/sections/*/actions/*/label" },
    ],
    guidance:
      `Keep every actions[].label to at most ${String(MAX_ACTION_LABEL_WORDS)} whitespace-delimited words. Reuse the exact same case-sensitive label only when the same action intent targets the same trimmed href; different destinations may use specific labels.`,
  },
  {
    id: "action-proof-authorization",
    errorSites: [{ code: "CONTENT_USE_NOT_ALLOWED", pathPattern: "/sections/*/actions/*/proofId" }],
    guidance:
      "Set actions[].proofId to null or to a contentProof id whose allowedUses includes action.",
  },
  {
    id: "content-ref-rendered-slot",
    errorSites: [{ code: "CONTENT_USE_NOT_ALLOWED", pathPattern: "/sections/*/contentRefs/*/use" }],
    guidance:
      "Match each sections[].contentRefs[].use to content the section renders: for this slot check headline, alt, metric and quote count as present; eyebrow only when eyebrow is non-null; body only when body is non-null; action only when actions is non-empty. Put evidence for a specific action on that actions[].proofId.",
  },
  {
    id: "ui-still-simulation",
    errorSites: [{ code: "UI_SIMULATION_UNAUTHORIZED", pathPattern: "/motion/*/simulationAuthorized" }],
    guidance:
      "Set simulationAuthorized true whenever a motion entry has sourceStillKind ui.",
  },
  {
    id: "intentional-exception-consumption",
    errorSites: [
      { code: "EXCEPTION_SCOPE_INVALID", pathPattern: "/intentionalExceptions/*" },
      { code: "EXCEPTION_SCOPE_INVALID", pathPattern: "/intentionalExceptions/*/sectionIds/*" },
      { code: "EXCEPTION_UNUSED", pathPattern: "/intentionalExceptions/*" },
    ],
    guidance:
      "Default intentionalExceptions to []. Active predicates are exactly: SERIF_DISPLAY only when displayStyle is serif AND pageKind is not editorial AND aestheticFamily is not editorial; PURPLE_PALETTE when paletteFamily is purple; WARM_CRAFT_PALETTE when paletteFamily is warm_craft; THEME_SWITCH when theme is section_switch; DIAL_DEVIATION when a motion trigger is scroll_progress AND motionIntensity is below 8; CENTERED_HERO when a route hero layoutFamily is centered_hero AND pageKind is neither editorial nor event_landing; LAYOUT_FAMILY_REPEAT when one layoutFamily occurs more than once on a route; SECOND_MARQUEE when a route has more than one marquee; TEXT_ONLY_PAGE when a route has no section whose visualKind is outside none and type_only. After drafting, add an exception only for an active predicate it will waive. The five global rules require routeId null and sectionIds []; route rules require an existing routeId and only sectionIds from that route, including every affected section the predicate checks. Omit every inactive exception; in particular, an editorial aesthetic needs no SERIF_DISPLAY exception.",
  },
  {
    id: "hero-order",
    errorSites: [{ code: "HERO_ORDER", pathPattern: "/sections/*/order" }],
    guidance:
      "For every route, put its one hero section id first in route.sectionIds and set that hero section order to 0.",
  },
  {
    id: "mobile-visible-slots",
    errorSites: [{ code: "MOBILE_ORDER_INVALID", pathPattern: "/sections/*/mobile/contentOrder" }],
    guidance:
      "Set each section mobile.contentOrder to every visible slot exactly once and no others: headline always; eyebrow iff eyebrow is non-null; body iff body is non-null; visual iff visualKind is not none; actions iff actions is non-empty.",
  },
] as const satisfies readonly {
  readonly id: string;
  readonly errorSites: readonly {
    readonly code: CreativeCompileErrorCode;
    readonly pathPattern: `/${string}`;
  }[];
  readonly guidance: string;
}[];

export interface CreativeCompileError {
  readonly code: CreativeCompileErrorCode;
  readonly path: string;
  readonly message: string;
}

export type CreativeCompileResult =
  | { readonly ok: true; readonly contract: CreativeContractV1; readonly canonicalJson: string; readonly contractHash: string }
  | { readonly ok: false; readonly errors: readonly CreativeCompileError[] };

export type CreativeContractSafeRepair =
  | {
      readonly code: "EXCEPTION_UNUSED";
      readonly path: string;
      readonly action: "delete_unused_exception";
      readonly before: IntentionalExceptionV1;
    }
  | {
      readonly code: "CONTENT_USE_NOT_ALLOWED";
      readonly path: string;
      readonly action: "remove_unauthorized_content_ref";
      readonly before: SectionContentRefV1;
    }
  | {
      readonly code: "CONTENT_USE_NOT_ALLOWED";
      readonly path: string;
      readonly action: "null_unauthorized_action_proof_id";
      readonly before: string;
    }
  | {
      readonly code: "ACTION_INTENT_LABEL_DRIFT";
      readonly path: string;
      readonly action: "reuse_prior_action_label";
      readonly before: string;
      readonly after: string;
    };

export interface CreativeContractAuthorCompileResult {
  readonly compiled: CreativeCompileResult;
  readonly repairs: readonly CreativeContractSafeRepair[];
}

type JsonRecord = Record<string, unknown>;
interface Context { readonly errors: CreativeCompileError[]; }

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ROUTE_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/u;
const PAGE_KIND_SET = new Set<string>(PAGE_KINDS);
const AESTHETIC_SET = new Set<string>(AESTHETIC_FAMILIES);
const SYSTEM_SET = new Set<string>(DESIGN_SYSTEMS);
const DISPLAY_SET = new Set<string>(DISPLAY_STYLES);
const PALETTE_SET = new Set<string>(PALETTE_FAMILIES);
const THEME_SET = new Set<string>(THEME_BEHAVIORS);
const STATUS_SET = new Set<string>(CONTENT_PROOF_STATUSES);
const USE_SET = new Set<string>(CONTENT_USES);
const EVIDENCE_SET = new Set<string>(EVIDENCE_KINDS);
const SECTION_SET = new Set<string>(SECTION_KINDS);
const LAYOUT_SET = new Set<string>(LAYOUT_FAMILIES);
const VISUAL_SET = new Set<string>(VISUAL_KINDS);
const INTENT_SET = new Set<string>(ACTION_INTENTS);
const PRIORITY_SET = new Set<string>(ACTION_PRIORITIES);
const MOBILE_SET = new Set<string>(MOBILE_STRATEGIES);
const SLOT_SET = new Set<string>(MOBILE_CONTENT_SLOTS);
const STATE_SET = new Set<string>(REQUIRED_RENDER_STATES);
const PURPOSE_SET = new Set<string>(MOTION_PURPOSES);
const TRIGGER_SET = new Set<string>(MOTION_TRIGGERS);
const IMPLEMENTATION_SET = new Set<string>(MOTION_IMPLEMENTATIONS);
const PROPERTY_SET = new Set<string>(MOTION_PROPERTIES);
const REDUCED_SET = new Set<string>(REDUCED_MOTION_FALLBACKS);
const NO_MEDIA_SET = new Set<string>(NO_MEDIA_FALLBACKS);
const STILL_SET = new Set<string>(SOURCE_STILL_KINDS);
const EXCEPTION_SET = new Set<string>(INTENTIONAL_EXCEPTION_RULES);

export const BANNED_CREATIVE_COPY = [
  "elevate", "seamless", "unleash", "next-gen", "revolutionize", "quietly in use at", "quietly trusted by",
  "from the field", "field notes", "currently on the bench", "on our desks", "scroll to explore", "john doe", "jane doe", "acme",
] as const;

function error(ctx: Context, code: CreativeCompileErrorCode, path: string, message: string): void {
  ctx.errors.push({ code, path, message });
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sorted(errors: readonly CreativeCompileError[]): readonly CreativeCompileError[] {
  return [...errors].sort((a, b) => compareText(a.path, b.path) || compareText(a.code, b.code));
}

function record(value: unknown, path: string, ctx: Context): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    error(ctx, path === "/" ? "INVALID_ROOT" : "INVALID_TYPE", path, "expected an object");
    return null;
  }
  return value as JsonRecord;
}

function exact(value: JsonRecord, path: string, keys: readonly string[], ctx: Context): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value).sort(compareText)) if (!allowed.has(key)) error(ctx, "UNKNOWN_KEY", `${path}/${key}`, "key is outside the closed schema");
  for (const key of keys) if (!Object.hasOwn(value, key)) error(ctx, "MISSING_KEY", `${path}/${key}`, "required key is missing");
}

function string(value: unknown, path: string, ctx: Context, max: number, nullable = false, pattern?: RegExp): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") { error(ctx, "INVALID_TYPE", path, "expected a string"); return null; }
  if (value.trim().length === 0 || value.length > max) { error(ctx, "LIMIT_EXCEEDED", path, `string must contain 1-${String(max)} characters`); return null; }
  if (pattern !== undefined && !pattern.test(value)) { error(ctx, "INVALID_VALUE", path, "string has an invalid format"); return null; }
  return value;
}

function enumString(value: unknown, path: string, ctx: Context, allowed: ReadonlySet<string>): string | null {
  const result = string(value, path, ctx, 64);
  if (result !== null && !allowed.has(result)) { error(ctx, "INVALID_VALUE", path, "value is outside the closed vocabulary"); return null; }
  return result;
}

function integer(value: unknown, path: string, ctx: Context, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) { error(ctx, "INVALID_TYPE", path, "expected a safe integer"); return null; }
  if (value < min || value > max) { error(ctx, "LIMIT_EXCEEDED", path, `integer must be ${String(min)}-${String(max)}`); return null; }
  return value;
}

function array(value: unknown, path: string, ctx: Context, min: number, max: number, visit: (item: unknown, path: string) => void): void {
  if (!Array.isArray(value)) { error(ctx, "INVALID_TYPE", path, "expected an array"); return; }
  if (value.length < min || value.length > max) error(ctx, "LIMIT_EXCEEDED", path, `array must contain ${String(min)}-${String(max)} values`);
  for (const [index, item] of value.entries()) visit(item, `${path}/${String(index)}`);
}

function stringArray(value: unknown, path: string, ctx: Context, min: number, max: number, allowed?: ReadonlySet<string>): void {
  const seen = new Set<string>();
  array(value, path, ctx, min, max, (item, itemPath) => {
    const parsed = string(item, itemPath, ctx, 128, false, allowed === undefined ? ID : undefined);
    if (parsed === null) return;
    if (allowed !== undefined && !allowed.has(parsed)) error(ctx, "INVALID_VALUE", itemPath, "value is outside the closed vocabulary");
    if (seen.has(parsed)) error(ctx, "DUPLICATE_VALUE", itemPath, "value must be unique");
    seen.add(parsed);
  });
}

function evidenceShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["kind", "locator", "sha256", "excerptSha256"], ctx);
  enumString(item["kind"], `${path}/kind`, ctx, EVIDENCE_SET);
  string(item["locator"], `${path}/locator`, ctx, 512);
  string(item["sha256"], `${path}/sha256`, ctx, 64, false, HASH);
  string(item["excerptSha256"], `${path}/excerptSha256`, ctx, 64, false, HASH);
}

function proofShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "claim", "status", "evidence", "allowedUses"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID);
  string(item["claim"], `${path}/claim`, ctx, 800);
  enumString(item["status"], `${path}/status`, ctx, STATUS_SET);
  evidenceShape(item["evidence"], `${path}/evidence`, ctx);
  stringArray(item["allowedUses"], `${path}/allowedUses`, ctx, 1, CONTENT_USES.length, USE_SET);
}

function contentRefShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["proofId", "use"], ctx);
  string(item["proofId"], `${path}/proofId`, ctx, 128, false, ID);
  enumString(item["use"], `${path}/use`, ctx, USE_SET);
}

function actionShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "label", "intent", "priority", "href", "proofId"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID);
  string(item["label"], `${path}/label`, ctx, 60);
  enumString(item["intent"], `${path}/intent`, ctx, INTENT_SET);
  enumString(item["priority"], `${path}/priority`, ctx, PRIORITY_SET);
  string(item["href"], `${path}/href`, ctx, 512);
  string(item["proofId"], `${path}/proofId`, ctx, 128, true, ID);
}

function mobileShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["strategy", "contentOrder"], ctx);
  enumString(item["strategy"], `${path}/strategy`, ctx, MOBILE_SET);
  stringArray(item["contentOrder"], `${path}/contentOrder`, ctx, 1, MOBILE_CONTENT_SLOTS.length, SLOT_SET);
}

function sectionShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "routeId", "order", "kind", "job", "contentRefs", "eyebrow", "headline", "body", "actions", "layoutFamily", "visualKind", "mobile", "requiredStates"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID);
  string(item["routeId"], `${path}/routeId`, ctx, 128, false, ID);
  integer(item["order"], `${path}/order`, ctx, 0, MAX_CREATIVE_SECTIONS - 1);
  enumString(item["kind"], `${path}/kind`, ctx, SECTION_SET);
  string(item["job"], `${path}/job`, ctx, 400);
  array(item["contentRefs"], `${path}/contentRefs`, ctx, 1, 20, (entry, entryPath) => contentRefShape(entry, entryPath, ctx));
  string(item["eyebrow"], `${path}/eyebrow`, ctx, 80, true);
  string(item["headline"], `${path}/headline`, ctx, 160);
  string(item["body"], `${path}/body`, ctx, 500, true);
  array(item["actions"], `${path}/actions`, ctx, 0, 4, (entry, entryPath) => actionShape(entry, entryPath, ctx));
  enumString(item["layoutFamily"], `${path}/layoutFamily`, ctx, LAYOUT_SET);
  enumString(item["visualKind"], `${path}/visualKind`, ctx, VISUAL_SET);
  mobileShape(item["mobile"], `${path}/mobile`, ctx);
  stringArray(item["requiredStates"], `${path}/requiredStates`, ctx, 1, REQUIRED_RENDER_STATES.length, STATE_SET);
}

function routeShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "path", "sectionIds"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID);
  string(item["path"], `${path}/path`, ctx, 256, false, ROUTE_PATH);
  stringArray(item["sectionIds"], `${path}/sectionIds`, ctx, 1, MAX_CREATIVE_SECTIONS);
}

function motionShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "routeId", "sectionId", "target", "purpose", "trigger", "implementation", "properties", "rationale", "fallback", "sourceStillKind", "simulationAuthorized"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID);
  string(item["routeId"], `${path}/routeId`, ctx, 128, false, ID);
  string(item["sectionId"], `${path}/sectionId`, ctx, 128, false, ID);
  string(item["target"], `${path}/target`, ctx, 200);
  enumString(item["purpose"], `${path}/purpose`, ctx, PURPOSE_SET);
  enumString(item["trigger"], `${path}/trigger`, ctx, TRIGGER_SET);
  enumString(item["implementation"], `${path}/implementation`, ctx, IMPLEMENTATION_SET);
  stringArray(item["properties"], `${path}/properties`, ctx, 1, MOTION_PROPERTIES.length, PROPERTY_SET);
  string(item["rationale"], `${path}/rationale`, ctx, 400);
  const fallback = record(item["fallback"], `${path}/fallback`, ctx);
  if (fallback !== null) {
    exact(fallback, `${path}/fallback`, ["reducedMotion", "noMedia"], ctx);
    enumString(fallback["reducedMotion"], `${path}/fallback/reducedMotion`, ctx, REDUCED_SET);
    enumString(fallback["noMedia"], `${path}/fallback/noMedia`, ctx, NO_MEDIA_SET);
  }
  enumString(item["sourceStillKind"], `${path}/sourceStillKind`, ctx, STILL_SET);
  if (typeof item["simulationAuthorized"] !== "boolean") error(ctx, "INVALID_TYPE", `${path}/simulationAuthorized`, "expected a boolean");
}

function exceptionShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["rule", "routeId", "sectionIds", "rationale", "evidence"], ctx);
  enumString(item["rule"], `${path}/rule`, ctx, EXCEPTION_SET);
  string(item["routeId"], `${path}/routeId`, ctx, 128, true, ID);
  stringArray(item["sectionIds"], `${path}/sectionIds`, ctx, 0, 8);
  string(item["rationale"], `${path}/rationale`, ctx, 400);
  evidenceShape(item["evidence"], `${path}/evidence`, ctx);
}

function contractShape(value: unknown, ctx: Context): void {
  const item = record(value, "/", ctx); if (item === null) return;
  exact(item, "", ["schemaVersion", "contractId", "designRead", "dials", "contentProof", "routes", "sections", "motion", "intentionalExceptions"], ctx);
  if (item["schemaVersion"] !== 1) error(ctx, "INVALID_VALUE", "/schemaVersion", "schemaVersion must equal 1");
  string(item["contractId"], "/contractId", ctx, 128, false, ID);
  const read = record(item["designRead"], "/designRead", ctx);
  if (read !== null) {
    exact(read, "/designRead", ["pageKind", "audience", "vibe", "aestheticFamily", "designSystem", "displayStyle", "paletteFamily", "theme", "thesis"], ctx);
    enumString(read["pageKind"], "/designRead/pageKind", ctx, PAGE_KIND_SET);
    string(read["audience"], "/designRead/audience", ctx, 300);
    string(read["vibe"], "/designRead/vibe", ctx, 200);
    enumString(read["aestheticFamily"], "/designRead/aestheticFamily", ctx, AESTHETIC_SET);
    enumString(read["designSystem"], "/designRead/designSystem", ctx, SYSTEM_SET);
    enumString(read["displayStyle"], "/designRead/displayStyle", ctx, DISPLAY_SET);
    enumString(read["paletteFamily"], "/designRead/paletteFamily", ctx, PALETTE_SET);
    enumString(read["theme"], "/designRead/theme", ctx, THEME_SET);
    string(read["thesis"], "/designRead/thesis", ctx, 500);
  }
  const dials = record(item["dials"], "/dials", ctx);
  if (dials !== null) {
    exact(dials, "/dials", ["designVariance", "motionIntensity", "visualDensity"], ctx);
    integer(dials["designVariance"], "/dials/designVariance", ctx, 1, 10);
    integer(dials["motionIntensity"], "/dials/motionIntensity", ctx, 1, 10);
    integer(dials["visualDensity"], "/dials/visualDensity", ctx, 1, 10);
  }
  array(item["contentProof"], "/contentProof", ctx, 1, MAX_CONTENT_PROOFS, (entry, path) => proofShape(entry, path, ctx));
  array(item["routes"], "/routes", ctx, 1, MAX_CREATIVE_ROUTES, (entry, path) => routeShape(entry, path, ctx));
  array(item["sections"], "/sections", ctx, 1, MAX_CREATIVE_SECTIONS, (entry, path) => sectionShape(entry, path, ctx));
  array(item["motion"], "/motion", ctx, 0, MAX_CREATIVE_MOTIONS, (entry, path) => motionShape(entry, path, ctx));
  array(item["intentionalExceptions"], "/intentionalExceptions", ctx, 0, MAX_CREATIVE_EXCEPTIONS, (entry, path) => exceptionShape(entry, path, ctx));
}

function duplicateIds<T extends { readonly id: string }>(items: readonly T[], base: string, ctx: Context): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    if (result.has(item.id)) error(ctx, "DUPLICATE_ID", `${base}/${String(index)}/id`, "id must be unique in this collection");
    else result.set(item.id, item);
  }
  return result;
}

function checkEvidence(reference: CreativeEvidenceRef, path: string, resolver: CreativeEvidenceResolver, ctx: Context): void {
  const resolved = resolver.resolve(reference);
  if (resolved === null) { error(ctx, "EVIDENCE_NOT_FOUND", path, "evidence resolver did not find this reference"); return; }
  if (!HASH.test(resolved.sha256) || !HASH.test(resolved.excerptSha256) || resolved.sha256 !== reference.sha256 || resolved.excerptSha256 !== reference.excerptSha256) {
    error(ctx, "EVIDENCE_DIGEST_MISMATCH", path, "resolved evidence digests do not match the contract");
  }
}

function wordCount(value: string): number { return value.trim().split(/\s+/u).filter(Boolean).length; }
function copyIsBanned(value: string): boolean {
  const lower = value.toLowerCase();
  return /[—–]/u.test(value) || BANNED_CREATIVE_COPY.some((phrase) => new RegExp(`(?:^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^a-z])`, "u").test(lower));
}

function semantic(contract: CreativeContractV1, resolver: CreativeEvidenceResolver, ctx: Context): void {
  const proofs = duplicateIds(contract.contentProof, "/contentProof", ctx);
  const routes = duplicateIds(contract.routes, "/routes", ctx);
  const sections = duplicateIds(contract.sections, "/sections", ctx);
  duplicateIds(contract.motion, "/motion", ctx);
  const proofUse = new Map<string, number>();
  const exceptionUse = new Set<number>();

  const routePaths = new Set<string>();
  for (const [index, route] of contract.routes.entries()) {
    if (routePaths.has(route.path)) error(ctx, "DUPLICATE_VALUE", `/routes/${String(index)}/path`, "route path must be unique");
    routePaths.add(route.path);
  }

  for (const [index, proof] of contract.contentProof.entries()) {
    checkEvidence(proof.evidence, `/contentProof/${String(index)}/evidence`, resolver, ctx);
    if (copyIsBanned(proof.claim)) error(ctx, "BANNED_COPY", `/contentProof/${String(index)}/claim`, "copy contains a forbidden generic phrase or dash character");
  }
  for (const [index, exception] of contract.intentionalExceptions.entries()) {
    checkEvidence(exception.evidence, `/intentionalExceptions/${String(index)}/evidence`, resolver, ctx);
    if (exception.routeId !== null && !routes.has(exception.routeId)) error(ctx, "DANGLING_ROUTE", `/intentionalExceptions/${String(index)}/routeId`, "exception route does not exist");
    for (const [position, sectionId] of exception.sectionIds.entries()) {
      const section = sections.get(sectionId);
      if (section === undefined) error(ctx, "DANGLING_SECTION", `/intentionalExceptions/${String(index)}/sectionIds/${String(position)}`, "exception section does not exist");
      else if (exception.routeId === null || section.routeId !== exception.routeId) error(ctx, "EXCEPTION_SCOPE_INVALID", `/intentionalExceptions/${String(index)}/sectionIds/${String(position)}`, "exception section must belong to its named route");
    }
    const global = new Set<IntentionalExceptionRule>(["SERIF_DISPLAY", "PURPLE_PALETTE", "WARM_CRAFT_PALETTE", "THEME_SWITCH", "DIAL_DEVIATION"]);
    if (global.has(exception.rule) ? exception.routeId !== null || exception.sectionIds.length !== 0 : exception.routeId === null) {
      error(ctx, "EXCEPTION_SCOPE_INVALID", `/intentionalExceptions/${String(index)}`, "exception scope does not match the rule");
    }
  }

  const useException = (rule: IntentionalExceptionRule, routeId: string | null, sectionIds: readonly string[] = []): boolean => {
    const index = contract.intentionalExceptions.findIndex((candidate) => candidate.rule === rule && candidate.routeId === routeId && sectionIds.every((id) => candidate.sectionIds.includes(id)));
    if (index < 0) return false;
    exceptionUse.add(index);
    return true;
  };

  if (contract.designRead.displayStyle === "serif" && contract.designRead.pageKind !== "editorial" && contract.designRead.aestheticFamily !== "editorial" && !useException("SERIF_DISPLAY", null)) error(ctx, "EXCEPTION_REQUIRED", "/designRead/displayStyle", "serif display requires an evidence-backed exception for this design read");
  if (contract.designRead.paletteFamily === "purple" && !useException("PURPLE_PALETTE", null)) error(ctx, "EXCEPTION_REQUIRED", "/designRead/paletteFamily", "purple palette requires an evidence-backed exception");
  if (contract.designRead.paletteFamily === "warm_craft" && !useException("WARM_CRAFT_PALETTE", null)) error(ctx, "EXCEPTION_REQUIRED", "/designRead/paletteFamily", "warm-craft palette requires an evidence-backed exception");
  if (contract.designRead.theme === "section_switch" && !useException("THEME_SWITCH", null)) error(ctx, "EXCEPTION_REQUIRED", "/designRead/theme", "section theme switching requires an evidence-backed exception");

  const destinationLabelsByIntent = new Map<string, Map<string, string>>();
  for (const [index, section] of contract.sections.entries()) {
    if (!routes.has(section.routeId)) error(ctx, "DANGLING_ROUTE", `/sections/${String(index)}/routeId`, "section route does not exist");
    if (copyIsBanned(section.headline)) error(ctx, "BANNED_COPY", `/sections/${String(index)}/headline`, "visible copy contains a forbidden generic phrase or dash character");
    if (section.eyebrow !== null && copyIsBanned(section.eyebrow)) error(ctx, "BANNED_COPY", `/sections/${String(index)}/eyebrow`, "visible copy contains a forbidden generic phrase or dash character");
    if (section.body !== null && copyIsBanned(section.body)) error(ctx, "BANNED_COPY", `/sections/${String(index)}/body`, "visible copy contains a forbidden generic phrase or dash character");
    const refs = new Set<string>();
    for (const [position, ref] of section.contentRefs.entries()) {
      const key = `${ref.proofId}:${ref.use}`;
      if (refs.has(key)) error(ctx, "DUPLICATE_VALUE", `/sections/${String(index)}/contentRefs/${String(position)}`, "content proof use must be unique per section");
      refs.add(key);
      const proof = proofs.get(ref.proofId);
      if (proof === undefined) error(ctx, "DANGLING_CONTENT_PROOF", `/sections/${String(index)}/contentRefs/${String(position)}/proofId`, "content proof does not exist");
      else {
        proofUse.set(ref.proofId, (proofUse.get(ref.proofId) ?? 0) + 1);
        if (!proof.allowedUses.includes(ref.use)) error(ctx, "CONTENT_USE_NOT_ALLOWED", `/sections/${String(index)}/contentRefs/${String(position)}/use`, "proof does not authorize this content use");
      }
      const present = ref.use === "eyebrow" ? section.eyebrow !== null : ref.use === "body" ? section.body !== null : ref.use === "action" ? section.actions.length > 0 : true;
      if (!present) error(ctx, "CONTENT_USE_NOT_ALLOWED", `/sections/${String(index)}/contentRefs/${String(position)}/use`, "content use has no corresponding section content");
    }
    const actionIds = new Set<string>();
    let primaryCount = 0;
    for (const [position, action] of section.actions.entries()) {
      if (actionIds.has(action.id)) error(ctx, "DUPLICATE_ID", `/sections/${String(index)}/actions/${String(position)}/id`, "action id must be unique in its section");
      actionIds.add(action.id);
      if (action.priority === "primary") primaryCount += 1;
      if (copyIsBanned(action.label)) error(ctx, "BANNED_COPY", `/sections/${String(index)}/actions/${String(position)}/label`, "action copy contains a forbidden generic phrase or dash character");
      if (wordCount(action.label) > MAX_ACTION_LABEL_WORDS) error(ctx, "LIMIT_EXCEEDED", `/sections/${String(index)}/actions/${String(position)}/label`, `action label must be at most ${String(MAX_ACTION_LABEL_WORDS)} words`);
      if (action.proofId !== null && !proofs.has(action.proofId)) error(ctx, "DANGLING_CONTENT_PROOF", `/sections/${String(index)}/actions/${String(position)}/proofId`, "action proof does not exist");
      if (action.proofId !== null) {
        proofUse.set(action.proofId, (proofUse.get(action.proofId) ?? 0) + 1);
        if (proofs.get(action.proofId)?.allowedUses.includes("action") !== true) error(ctx, "CONTENT_USE_NOT_ALLOWED", `/sections/${String(index)}/actions/${String(position)}/proofId`, "proof does not authorize action use");
      }
      const destinationLabels = destinationLabelsByIntent.get(action.intent) ?? new Map<string, string>();
      destinationLabelsByIntent.set(action.intent, destinationLabels);
      const destination = action.href.trim();
      const prior = destinationLabels.get(destination);
      if (prior !== undefined && prior !== action.label) error(ctx, "ACTION_INTENT_LABEL_DRIFT", `/sections/${String(index)}/actions/${String(position)}/label`, "one action intent and destination must use one label across the contract");
      else destinationLabels.set(destination, action.label);
    }
    if (primaryCount > 1) error(ctx, "ACTION_PRIMARY_LIMIT", `/sections/${String(index)}/actions`, "section may have at most one primary action");
    const requiredSlots: MobileContentSlot[] = ["headline"];
    if (section.eyebrow !== null) requiredSlots.push("eyebrow");
    if (section.body !== null) requiredSlots.push("body");
    if (section.visualKind !== "none") requiredSlots.push("visual");
    if (section.actions.length > 0) requiredSlots.push("actions");
    if (section.mobile.contentOrder.length !== requiredSlots.length || requiredSlots.some((slot) => !section.mobile.contentOrder.includes(slot))) error(ctx, "MOBILE_ORDER_INVALID", `/sections/${String(index)}/mobile/contentOrder`, "mobile order must cover each visible content slot exactly once");
    const multiColumn = new Set<LayoutFamily>(["asymmetric_split", "split_media_left", "split_media_right", "bento", "masonry", "sticky_stack", "horizontal_pan", "pricing_columns"]);
    if (multiColumn.has(section.layoutFamily) && section.mobile.strategy === "preserve") error(ctx, "MOBILE_COLLAPSE_REQUIRED", `/sections/${String(index)}/mobile/strategy`, "multi-column layout must declare a mobile collapse strategy");
  }

  for (const [index, proof] of contract.contentProof.entries()) if (!proofUse.has(proof.id)) error(ctx, "CONTENT_PROOF_UNUSED", `/contentProof/${String(index)}`, "content proof is not used by any section or action");

  for (const [routeIndex, route] of contract.routes.entries()) {
    const routeSections = route.sectionIds.map((id) => sections.get(id)).filter((item): item is CreativeSectionV1 => item !== undefined);
    for (const [position, sectionId] of route.sectionIds.entries()) {
      const section = sections.get(sectionId);
      if (section === undefined) error(ctx, "DANGLING_SECTION", `/routes/${String(routeIndex)}/sectionIds/${String(position)}`, "route section does not exist");
      else {
        if (section.routeId !== route.id) error(ctx, "DANGLING_ROUTE", `/routes/${String(routeIndex)}/sectionIds/${String(position)}`, "section belongs to a different route");
        if (section.order !== position) error(ctx, "ROUTE_ORDER_INVALID", `/sections/${String(contract.sections.indexOf(section))}/order`, "section order must equal its route position");
      }
    }
    const declared = contract.sections.filter((section) => section.routeId === route.id);
    if (declared.length !== routeSections.length) error(ctx, "DANGLING_SECTION", `/routes/${String(routeIndex)}/sectionIds`, "route section list must cover every section assigned to the route");
    const heroes = routeSections.filter((section) => section.kind === "hero");
    if (heroes.length === 0) error(ctx, "HERO_MISSING", `/routes/${String(routeIndex)}/sectionIds`, "route requires one hero section");
    if (heroes.length > 1) error(ctx, "HERO_MULTIPLE", `/routes/${String(routeIndex)}/sectionIds`, "route may contain only one hero section");
    const hero = heroes[0];
    if (hero !== undefined) {
      const heroIndex = contract.sections.indexOf(hero);
      if (routeSections[0]?.id !== hero.id || hero.order !== 0) error(ctx, "HERO_ORDER", `/sections/${String(heroIndex)}/order`, "hero must be first on its route");
      if (hero.headline.split(/\r?\n/u).length > 2) error(ctx, "HERO_HEADLINE_TOO_LONG", `/sections/${String(heroIndex)}/headline`, "hero headline may contain at most two authored lines");
      if (hero.body !== null && wordCount(hero.body) > 20) error(ctx, "HERO_BODY_TOO_LONG", `/sections/${String(heroIndex)}/body`, "hero body must be at most 20 words");
      if (hero.actions.length > 2) error(ctx, "HERO_ACTION_LIMIT", `/sections/${String(heroIndex)}/actions`, "hero may contain at most two actions");
      if (hero.actions.length > 0 && hero.actions.filter((action) => action.priority === "primary").length !== 1) error(ctx, "HERO_PRIMARY_ACTION_INVALID", `/sections/${String(heroIndex)}/actions`, "hero actions require exactly one primary action");
      if (hero.layoutFamily === "centered_hero" && contract.designRead.pageKind !== "editorial" && contract.designRead.pageKind !== "event_landing" && !useException("CENTERED_HERO", route.id, [hero.id])) error(ctx, "EXCEPTION_REQUIRED", `/sections/${String(heroIndex)}/layoutFamily`, "centered hero requires a scoped intentional exception for this page kind");
    }
    const eyebrowPositions = routeSections.flatMap((section, position) => section.eyebrow === null ? [] : [position]);
    if (eyebrowPositions.length > Math.ceil(routeSections.length / 3)) error(ctx, "EYEBROW_LIMIT", `/routes/${String(routeIndex)}/sectionIds`, "route exceeds one eyebrow per three sections");
    for (let i = 1; i < eyebrowPositions.length; i += 1) if ((eyebrowPositions[i] ?? 0) - (eyebrowPositions[i - 1] ?? 0) < 3) error(ctx, "EYEBROW_SPACING", `/routes/${String(routeIndex)}/sectionIds/${String(eyebrowPositions[i])}`, "eyebrows require two intervening sections");
    for (const section of routeSections) if (section.eyebrow !== null && /^(?:0*\d+|(?:stage|step|phase|pass)\s+\d+)/iu.test(section.eyebrow.trim())) error(ctx, "EYEBROW_NUMBERED", `/sections/${String(contract.sections.indexOf(section))}/eyebrow`, "numbered eyebrows are forbidden");
    const families = new Map<LayoutFamily, CreativeSectionV1[]>();
    for (const section of routeSections) families.set(section.layoutFamily, [...(families.get(section.layoutFamily) ?? []), section]);
    for (const [family, repeated] of families) if (repeated.length > 1 && !useException("LAYOUT_FAMILY_REPEAT", route.id, repeated.map((section) => section.id))) error(ctx, "LAYOUT_FAMILY_REPEATED", `/routes/${String(routeIndex)}/sectionIds`, `layout family ${family} is repeated without an exception`);
    if (routeSections.length >= 8 && families.size < 4) error(ctx, "LAYOUT_FAMILY_COVERAGE", `/routes/${String(routeIndex)}/sectionIds`, "eight-section routes require at least four layout families");
    let splitRun = 0;
    for (const section of routeSections) {
      splitRun = section.layoutFamily === "split_media_left" || section.layoutFamily === "split_media_right" ? splitRun + 1 : 0;
      if (splitRun > 2) error(ctx, "ZIGZAG_LIMIT", `/sections/${String(contract.sections.indexOf(section))}/layoutFamily`, "at most two consecutive split-media sections are allowed");
    }
    const marquees = routeSections.filter((section) => section.layoutFamily === "marquee");
    if (marquees.length > 1 && !useException("SECOND_MARQUEE", route.id, marquees.map((section) => section.id))) error(ctx, "MARQUEE_LIMIT", `/routes/${String(routeIndex)}/sectionIds`, "route may contain one marquee without an exception");
    const visualCount = routeSections.filter((section) => !["none", "type_only"].includes(section.visualKind)).length;
    if (visualCount === 0 && !useException("TEXT_ONLY_PAGE", route.id, route.sectionIds)) error(ctx, "VISUAL_REQUIRED", `/routes/${String(routeIndex)}/sectionIds`, "route requires a real visual or an intentional text-only exception");
  }

  for (const [index, motion] of contract.motion.entries()) {
    const route = routes.get(motion.routeId);
    const section = sections.get(motion.sectionId);
    if (route === undefined) error(ctx, "DANGLING_ROUTE", `/motion/${String(index)}/routeId`, "motion route does not exist");
    if (section === undefined) error(ctx, "DANGLING_SECTION", `/motion/${String(index)}/sectionId`, "motion section does not exist");
    else if (section.routeId !== motion.routeId) error(ctx, "DANGLING_ROUTE", `/motion/${String(index)}/sectionId`, "motion section belongs to a different route");
    else if (motion.trigger === "interaction" && !section.requiredStates.includes("interaction")) error(ctx, "MOTION_FALLBACK_INVALID", `/motion/${String(index)}/trigger`, "interaction motion requires an interaction render state on its section");
    if (motion.properties.some((property) => property !== "opacity" && property !== "transform")) error(ctx, "MOTION_PROPERTY_FORBIDDEN", `/motion/${String(index)}/properties`, "motion may animate only opacity and transform");
    if (motion.trigger === "scroll_progress" && contract.dials.motionIntensity < 8 && !useException("DIAL_DEVIATION", null)) error(ctx, "MOTION_DIAL_CONFLICT", `/motion/${String(index)}/trigger`, "scroll-progress motion requires intensity 8-10 or a dial exception");
    if (motion.sourceStillKind === "ui" && !motion.simulationAuthorized) error(ctx, "UI_SIMULATION_UNAUTHORIZED", `/motion/${String(index)}/simulationAuthorized`, "UI still simulation requires explicit authorization");
    if (motion.fallback.reducedMotion.length === 0 || motion.fallback.noMedia.length === 0) error(ctx, "MOTION_FALLBACK_INVALID", `/motion/${String(index)}/fallback`, "motion requires reduced-motion and no-media fallbacks");
  }
  if (contract.dials.motionIntensity > 4 && contract.motion.length === 0) error(ctx, "MOTION_REQUIRED", "/motion", "motion intensity above 4 requires at least one motivated motion entry");
  for (const [index] of contract.intentionalExceptions.entries()) if (!exceptionUse.has(index)) error(ctx, "EXCEPTION_UNUSED", `/intentionalExceptions/${String(index)}`, "intentional exception does not waive an active contract rule");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    const source = value as JsonRecord;
    const output: JsonRecord = {};
    for (const key of Object.keys(source).sort(compareText)) output[key] = canonicalValue(source[key]);
    return output;
  }
  return value;
}

export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalValue(value)); }
export function sha256Hex(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function compileCreativeContract(text: string, resolver: CreativeEvidenceResolver): CreativeCompileResult {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()) as unknown; }
  catch { return { ok: false, errors: [{ code: "INVALID_JSON", path: "/", message: "contract must be exactly one JSON object" }] }; }
  const ctx: Context = { errors: [] };
  contractShape(raw, ctx);
  if (ctx.errors.length > 0) return { ok: false, errors: sorted(ctx.errors) };
  const contract = raw as CreativeContractV1;
  semantic(contract, resolver, ctx);
  if (ctx.errors.length > 0) return { ok: false, errors: sorted(ctx.errors) };
  const result = canonicalJson(contract);
  return { ok: true, contract, canonicalJson: result, contractHash: sha256Hex(result) };
}

type SafeRepairTarget =
  | { readonly kind: "exception"; readonly index: number; readonly error: CreativeCompileError }
  | { readonly kind: "contentRef"; readonly sectionIndex: number; readonly index: number; readonly error: CreativeCompileError }
  | { readonly kind: "actionProof"; readonly sectionIndex: number; readonly index: number; readonly error: CreativeCompileError }
  | { readonly kind: "actionLabel"; readonly sectionIndex: number; readonly index: number; readonly error: CreativeCompileError };

function safeRepairTarget(error: CreativeCompileError): SafeRepairTarget | null {
  let match: RegExpExecArray | null;
  if (error.code === "EXCEPTION_UNUSED" && (match = /^\/intentionalExceptions\/(\d+)$/u.exec(error.path)) !== null) {
    return { kind: "exception", index: Number(match[1]), error };
  }
  if (error.code === "ACTION_INTENT_LABEL_DRIFT" &&
    (match = /^\/sections\/(\d+)\/actions\/(\d+)\/label$/u.exec(error.path)) !== null) {
    return { kind: "actionLabel", sectionIndex: Number(match[1]), index: Number(match[2]), error };
  }
  if (error.code !== "CONTENT_USE_NOT_ALLOWED") return null;
  if ((match = /^\/sections\/(\d+)\/contentRefs\/(\d+)\/use$/u.exec(error.path)) !== null) {
    return { kind: "contentRef", sectionIndex: Number(match[1]), index: Number(match[2]), error };
  }
  if ((match = /^\/sections\/(\d+)\/actions\/(\d+)\/proofId$/u.exec(error.path)) !== null) {
    return { kind: "actionProof", sectionIndex: Number(match[1]), index: Number(match[2]), error };
  }
  return null;
}

/**
 * Author-boundary repair policy owned beside the deterministic compiler.
 * It can only remove invalid authority links or reuse one unambiguous earlier
 * action label; any other finding prevents the pass, and the fully repaired
 * candidate must still compile from scratch.
 */
export function compileCreativeContractAuthorOutput(
  text: string,
  resolver: CreativeEvidenceResolver,
): CreativeContractAuthorCompileResult {
  const initial = compileCreativeContract(text, resolver);
  if (initial.ok) return { compiled: initial, repairs: [] };
  const targets: SafeRepairTarget[] = [];
  for (const error of initial.errors) {
    const target = safeRepairTarget(error);
    if (target === null) return { compiled: initial, repairs: [] };
    targets.push(target);
  }

  let contract: CreativeContractV1;
  try { contract = JSON.parse(text.trim()) as CreativeContractV1; }
  catch { return { compiled: initial, repairs: [] }; }
  const candidate = structuredClone(contract) as unknown as {
    intentionalExceptions: IntentionalExceptionV1[];
    sections: Array<{
      contentRefs: SectionContentRefV1[];
      actions: Array<{ label: string; intent: ActionIntent; href: string; proofId: string | null }>;
    }>;
  };
  const uniqueTargets = new Map<string, SafeRepairTarget>();
  for (const target of targets) {
    const key = `${target.kind}:${target.error.path}`;
    if (!uniqueTargets.has(key)) uniqueTargets.set(key, target);
  }

  const repairs: CreativeContractSafeRepair[] = [];
  const labelAfter = new Map<string, string>();
  for (const target of uniqueTargets.values()) {
    if (target.kind === "exception") {
      const before = candidate.intentionalExceptions[target.index];
      if (before === undefined) return { compiled: initial, repairs: [] };
      repairs.push({ code: "EXCEPTION_UNUSED", path: target.error.path, action: "delete_unused_exception", before: structuredClone(before) });
      continue;
    }
    const section = candidate.sections[target.sectionIndex];
    if (section === undefined) return { compiled: initial, repairs: [] };
    if (target.kind === "contentRef") {
      const before = section.contentRefs[target.index];
      if (before === undefined) return { compiled: initial, repairs: [] };
      repairs.push({ code: "CONTENT_USE_NOT_ALLOWED", path: target.error.path, action: "remove_unauthorized_content_ref", before: structuredClone(before) });
      continue;
    }
    const action = section.actions[target.index];
    if (action === undefined) return { compiled: initial, repairs: [] };
    if (target.kind === "actionProof") {
      if (typeof action.proofId !== "string") return { compiled: initial, repairs: [] };
      repairs.push({ code: "CONTENT_USE_NOT_ALLOWED", path: target.error.path, action: "null_unauthorized_action_proof_id", before: action.proofId });
      continue;
    }
    const predecessors = candidate.sections.flatMap((priorSection, sectionIndex) =>
      sectionIndex > target.sectionIndex
        ? []
        : priorSection.actions.slice(0, sectionIndex === target.sectionIndex ? target.index : undefined)
          .filter((prior) => prior.intent === action.intent && prior.href.trim() === action.href.trim()));
    if (predecessors.length !== 1 || predecessors[0]!.label === action.label) return { compiled: initial, repairs: [] };
    repairs.push({
      code: "ACTION_INTENT_LABEL_DRIFT",
      path: target.error.path,
      action: "reuse_prior_action_label",
      before: action.label,
      after: predecessors[0]!.label,
    });
    labelAfter.set(target.error.path, predecessors[0]!.label);
  }

  const mutationTargets = [...uniqueTargets.values()];
  for (const target of mutationTargets) {
    if (target.kind === "actionProof") candidate.sections[target.sectionIndex]!.actions[target.index]!.proofId = null;
    else if (target.kind === "actionLabel") {
      const after = labelAfter.get(target.error.path);
      if (after === undefined) return { compiled: initial, repairs: [] };
      candidate.sections[target.sectionIndex]!.actions[target.index]!.label = after;
    }
  }
  for (const target of mutationTargets
    .filter((item): item is Extract<SafeRepairTarget, { readonly kind: "contentRef" }> => item.kind === "contentRef")
    .sort((left, right) => right.sectionIndex - left.sectionIndex || right.index - left.index)) {
    candidate.sections[target.sectionIndex]!.contentRefs.splice(target.index, 1);
  }
  for (const target of mutationTargets
    .filter((item): item is Extract<SafeRepairTarget, { readonly kind: "exception" }> => item.kind === "exception")
    .sort((left, right) => right.index - left.index)) {
    candidate.intentionalExceptions.splice(target.index, 1);
  }
  return {
    compiled: compileCreativeContract(canonicalJson(candidate), resolver),
    repairs,
  };
}
