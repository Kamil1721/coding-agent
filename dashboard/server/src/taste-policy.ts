/**
 * Pure policy boundary for the independent rendered-taste critic.
 *
 * This module owns vocabulary, prompt composition and fail-closed validation.
 * It performs no model call, file access, rendering or orchestration.
 */

export const TASTE_POLICY_SCHEMA_VERSION = 1 as const;
export const MAX_TASTE_FINDINGS = 10;
export const MAX_TASTE_FINDINGS_PER_CATEGORY = 2;
export const MIN_TASTE_EVIDENCE_PER_FINDING = 2;
export const MAX_TASTE_EVIDENCE_PER_FINDING = 8;
export const MAX_TASTE_PROMPT_FACTS = 48;
export const MAX_TASTE_PROMPT_CHARS = 40_000;

export const TASTE_CATEGORIES = [
  "copy",
  "layout",
  "motion",
  "imagery",
  "hierarchy",
  "mobile",
  "reduced_motion",
] as const;

export type TasteCategory = (typeof TASTE_CATEGORIES)[number];

export const TASTE_FINDING_CODES = [
  "GENERIC_COPY",
  "COPY_JOB_MISMATCH",
  "COPY_PROOF_MISSING",
  "COPY_REGISTER_DRIFT",
  "COPY_REPETITION",
  "LAYOUT_GRAMMAR_REPEATED",
  "SECTION_JOB_UNCLEAR",
  "CONTRACT_LAYOUT_DRIFT",
  "MOTION_UNDECLARED",
  "MOTION_PURPOSE_MISMATCH",
  "MOTION_PLACEMENT_WRONG",
  "IMAGE_PROVENANCE_UNKNOWN",
  "IMAGE_INTENT_MISMATCH",
  "PLACEHOLDER_MEDIA",
  "HIERARCHY_FLAT",
  "PRIMARY_ACTION_COMPETES",
  "MOBILE_REFLOW_BROKEN",
  "MOBILE_ORDER_WRONG",
  "MOBILE_OVERFLOW",
  "REDUCED_MOTION_ACTIVE",
  "REDUCED_MOTION_CONTENT_LOST",
] as const;

export type TasteFindingCode = (typeof TASTE_FINDING_CODES)[number];

export const TASTE_CODE_CATEGORY: Readonly<Record<TasteFindingCode, TasteCategory>> = Object.freeze({
  GENERIC_COPY: "copy",
  COPY_JOB_MISMATCH: "copy",
  COPY_PROOF_MISSING: "copy",
  COPY_REGISTER_DRIFT: "copy",
  COPY_REPETITION: "copy",
  LAYOUT_GRAMMAR_REPEATED: "layout",
  SECTION_JOB_UNCLEAR: "layout",
  CONTRACT_LAYOUT_DRIFT: "layout",
  MOTION_UNDECLARED: "motion",
  MOTION_PURPOSE_MISMATCH: "motion",
  MOTION_PLACEMENT_WRONG: "motion",
  IMAGE_PROVENANCE_UNKNOWN: "imagery",
  IMAGE_INTENT_MISMATCH: "imagery",
  PLACEHOLDER_MEDIA: "imagery",
  HIERARCHY_FLAT: "hierarchy",
  PRIMARY_ACTION_COMPETES: "hierarchy",
  MOBILE_REFLOW_BROKEN: "mobile",
  MOBILE_ORDER_WRONG: "mobile",
  MOBILE_OVERFLOW: "mobile",
  REDUCED_MOTION_ACTIVE: "reduced_motion",
  REDUCED_MOTION_CONTENT_LOST: "reduced_motion",
});

export const TASTE_ASSET_PROVENANCE = ["matched", "unknown", "forbidden_remote", "missing"] as const;
export type TasteAssetProvenance = (typeof TASTE_ASSET_PROVENANCE)[number];

export interface DomTextEvidence {
  readonly kind: "dom_text";
  readonly frameId: string;
  readonly sectionId: string;
  readonly excerpt: string;
  readonly textSha256: string;
}

export interface RegionEvidence {
  readonly kind: "region";
  readonly frameId: string;
  readonly sectionId: string;
  readonly screenshotSha256: string;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface ContractEvidence {
  readonly kind: "contract";
  readonly pointer: string;
  readonly valueSha256: string;
}

export interface MotionTraceEvidence {
  readonly kind: "motion_trace";
  readonly frameId: string;
  readonly motionId: string;
  readonly sampleIndexes: readonly number[];
  readonly observedProperties: readonly string[];
}

export interface AssetEvidence {
  readonly kind: "asset";
  readonly frameId: string;
  readonly sectionId: string;
  readonly contentSha256: string | null;
  readonly provenance: TasteAssetProvenance;
}

export type TasteEvidence =
  | DomTextEvidence
  | RegionEvidence
  | ContractEvidence
  | MotionTraceEvidence
  | AssetEvidence;

export interface TasteFindingV1 {
  readonly id: string;
  readonly category: TasteCategory;
  readonly code: TasteFindingCode;
  readonly routeId: string;
  readonly sectionIds: readonly string[];
  readonly diagnosis: string;
  readonly revision: string;
  readonly evidence: readonly TasteEvidence[];
}

/** The absence of findings is the only pass signal. There is no prose verdict. */
export interface TasteCriticOutputV1 {
  readonly schemaVersion: typeof TASTE_POLICY_SCHEMA_VERSION;
  readonly contractHash: string;
  readonly renderManifestHash: string;
  readonly findings: readonly TasteFindingV1[];
}

export interface TasteRouteIndex {
  readonly id: string;
  readonly sectionIds: readonly string[];
}

export interface TasteFrameIndex {
  readonly id: string;
  readonly routeId: string;
  readonly sectionIds: readonly string[];
  readonly motionIds: readonly string[];
}

/** Host projection of the two immutable artefacts. It contains references, not bytes. */
export interface TasteEvidenceIndex {
  readonly contractHash: string;
  readonly renderManifestHash: string;
  readonly routes: readonly TasteRouteIndex[];
  readonly frames: readonly TasteFrameIndex[];
  readonly contractPointers: readonly string[];
  /** Exact canonical references projected from the manifest and contract. */
  readonly evidence: readonly TasteEvidence[];
}

export const TASTE_INTENTIONAL_EXCEPTION_RULES = [
  "CENTERED_HERO",
  "SERIF_DISPLAY",
  "PURPLE_PALETTE",
  "WARM_CRAFT_PALETTE",
  "THEME_SWITCH",
  "LAYOUT_FAMILY_REPEAT",
  "SECOND_MARQUEE",
  "TEXT_ONLY_PAGE",
  "DIAL_DEVIATION",
] as const;

export type TasteIntentionalExceptionRule = (typeof TASTE_INTENTIONAL_EXCEPTION_RULES)[number];

export interface TasteIntentionalException {
  readonly rule: TasteIntentionalExceptionRule;
  readonly sectionIds: readonly string[];
  readonly rationale: string;
}

export interface TastePromptFact {
  readonly id: string;
  /** Canonical evidence that the critic may copy into a finding. */
  readonly evidence: TasteEvidence;
  /** Bounded host observation. Never source code, HTML, CSS or image bytes. */
  readonly observation: string;
}

export interface TasteCriticPromptInput {
  readonly evidenceIndex: TasteEvidenceIndex;
  readonly facts: readonly TastePromptFact[];
  readonly intentionalExceptions: readonly TasteIntentionalException[];
}

export type TastePolicyErrorCode =
  | "INVALID_JSON"
  | "INVALID_ROOT"
  | "UNKNOWN_KEY"
  | "MISSING_KEY"
  | "INVALID_TYPE"
  | "INVALID_VALUE"
  | "LIMIT_EXCEEDED"
  | "WRONG_CONTRACT_HASH"
  | "WRONG_RENDER_MANIFEST_HASH"
  | "DUPLICATE_FINDING_ID"
  | "DUPLICATE_VALUE"
  | "CATEGORY_CODE_MISMATCH"
  | "UNKNOWN_ROUTE"
  | "UNKNOWN_FRAME"
  | "UNKNOWN_SECTION"
  | "UNKNOWN_MOTION"
  | "UNKNOWN_CONTRACT_POINTER"
  | "UNKNOWN_EVIDENCE_REFERENCE"
  | "SECTION_ROUTE_MISMATCH"
  | "FRAME_ROUTE_MISMATCH"
  | "EVIDENCE_SECTION_MISMATCH"
  | "TOO_FEW_GROUNDED_EVIDENCE"
  | "PREFERENCE_ONLY_DIAGNOSIS";

export interface TastePolicyError {
  readonly code: TastePolicyErrorCode;
  readonly path: string;
  readonly message: string;
}

export type TastePolicyParseResult =
  | { readonly ok: true; readonly output: TasteCriticOutputV1 }
  | { readonly ok: false; readonly errors: readonly TastePolicyError[] };

interface CompiledIndex {
  readonly routes: ReadonlyMap<string, ReadonlySet<string>>;
  readonly frames: ReadonlyMap<string, TasteFrameIndex>;
  readonly pointers: ReadonlySet<string>;
  readonly evidenceIdentities: ReadonlySet<string> | null;
}

type UnknownRecord = Record<string, unknown>;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const CATEGORY_SET = new Set<string>(TASTE_CATEGORIES);
const CODE_SET = new Set<string>(TASTE_FINDING_CODES);
const PROVENANCE_SET = new Set<string>(TASTE_ASSET_PROVENANCE);
const EXCEPTION_SET = new Set<string>(TASTE_INTENTIONAL_EXCEPTION_RULES);

function pushError(
  errors: TastePolicyError[],
  code: TastePolicyErrorCode,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function sortedErrors(errors: readonly TastePolicyError[]): readonly TastePolicyError[] {
  return [...errors].sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
}

function asRecord(value: unknown, path: string, errors: TastePolicyError[]): UnknownRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    pushError(errors, path === "" ? "INVALID_ROOT" : "INVALID_TYPE", path || "/", "expected an object");
    return null;
  }
  return value as UnknownRecord;
}

function enforceExactKeys(
  value: UnknownRecord,
  path: string,
  keys: readonly string[],
  errors: TastePolicyError[],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) pushError(errors, "UNKNOWN_KEY", `${path}/${key}`, "key is not allowed by the closed schema");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) pushError(errors, "MISSING_KEY", `${path}/${key}`, "required key is missing");
  }
}

function boundedString(
  value: unknown,
  path: string,
  errors: TastePolicyError[],
  maximum: number,
  options: { readonly allowEmpty?: boolean; readonly pattern?: RegExp } = {},
): string | null {
  if (typeof value !== "string") {
    pushError(errors, "INVALID_TYPE", path, "expected a string");
    return null;
  }
  if ((options.allowEmpty !== true && value.trim().length === 0) || value.length > maximum) {
    pushError(errors, "LIMIT_EXCEEDED", path, `string must contain 1-${String(maximum)} characters`);
    return null;
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    pushError(errors, "INVALID_VALUE", path, "string does not match the required format");
    return null;
  }
  return value;
}

function sha256(value: unknown, path: string, errors: TastePolicyError[], nullable = false): string | null {
  if (nullable && value === null) return null;
  return boundedString(value, path, errors, 64, { pattern: HASH_PATTERN });
}

function uniqueStrings(
  value: unknown,
  path: string,
  errors: TastePolicyError[],
  minimum: number,
  maximum: number,
  itemMaximum = 128,
): readonly string[] | null {
  if (!Array.isArray(value)) {
    pushError(errors, "INVALID_TYPE", path, "expected an array");
    return null;
  }
  if (value.length < minimum || value.length > maximum) {
    pushError(errors, "LIMIT_EXCEEDED", path, `array must contain ${String(minimum)}-${String(maximum)} values`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const parsed = boundedString(item, `${path}/${String(index)}`, errors, itemMaximum, { pattern: SAFE_ID_PATTERN });
    if (parsed === null) continue;
    if (seen.has(parsed)) pushError(errors, "DUPLICATE_VALUE", `${path}/${String(index)}`, "value must be unique");
    else {
      seen.add(parsed);
      output.push(parsed);
    }
  }
  return output;
}

function compileIndex(index: TasteEvidenceIndex): CompiledIndex {
  if (!HASH_PATTERN.test(index.contractHash) || !HASH_PATTERN.test(index.renderManifestHash)) {
    throw new Error("Taste evidence index hashes must be lowercase SHA-256 values");
  }
  const routes = new Map<string, ReadonlySet<string>>();
  for (const route of index.routes) {
    if (routes.has(route.id)) throw new Error(`Duplicate taste route index: ${route.id}`);
    routes.set(route.id, new Set(route.sectionIds));
  }
  const frames = new Map<string, TasteFrameIndex>();
  for (const frame of index.frames) {
    if (frames.has(frame.id)) throw new Error(`Duplicate taste frame index: ${frame.id}`);
    if (!routes.has(frame.routeId)) throw new Error(`Taste frame ${frame.id} refers to unknown route ${frame.routeId}`);
    frames.set(frame.id, frame);
  }
  const ungrounded: CompiledIndex = {
    routes,
    frames,
    pointers: new Set(index.contractPointers),
    evidenceIdentities: null,
  };
  const evidenceIdentities = new Set<string>();
  for (const [position, candidate] of index.evidence.entries()) {
    const errors: TastePolicyError[] = [];
    const evidence = validateEvidence(candidate, `/evidence/${String(position)}`, null, null, ungrounded, errors);
    if (evidence === null || errors.length > 0) {
      const first = sortedErrors(errors)[0];
      throw new Error(`Invalid canonical taste evidence: ${first?.code ?? "UNKNOWN"} at ${first?.path ?? "/"}`);
    }
    const identity = evidenceIdentity(evidence);
    if (evidenceIdentities.has(identity)) throw new Error(`Duplicate canonical taste evidence at ${String(position)}`);
    evidenceIdentities.add(identity);
  }
  return { ...ungrounded, evidenceIdentities };
}

function groundEvidence<T extends TasteEvidence>(
  evidence: T,
  path: string,
  compiled: CompiledIndex,
  errors: TastePolicyError[],
): T | null {
  if (compiled.evidenceIdentities !== null && !compiled.evidenceIdentities.has(evidenceIdentity(evidence))) {
    pushError(errors, "UNKNOWN_EVIDENCE_REFERENCE", path, "evidence object is not present in the injected canonical index");
    return null;
  }
  return evidence;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  errors: TastePolicyError[],
): T | null {
  if (typeof value !== "string") {
    pushError(errors, "INVALID_TYPE", path, "expected a string enum value");
    return null;
  }
  if (!allowed.has(value)) {
    pushError(errors, "INVALID_VALUE", path, "value is outside the closed vocabulary");
    return null;
  }
  return value as T;
}

function validateFrame(
  frameId: string | null,
  path: string,
  expectedRouteId: string | null,
  compiled: CompiledIndex,
  errors: TastePolicyError[],
): TasteFrameIndex | null {
  if (frameId === null) return null;
  const frame = compiled.frames.get(frameId);
  if (frame === undefined) {
    pushError(errors, "UNKNOWN_FRAME", path, "frame is not present in the render manifest index");
    return null;
  }
  if (expectedRouteId !== null && frame.routeId !== expectedRouteId) {
    pushError(errors, "FRAME_ROUTE_MISMATCH", path, "frame belongs to a different route");
    return null;
  }
  return frame;
}

function validateEvidence(
  value: unknown,
  path: string,
  expectedRouteId: string | null,
  findingSectionIds: ReadonlySet<string> | null,
  compiled: CompiledIndex,
  errors: TastePolicyError[],
): TasteEvidence | null {
  const record = asRecord(value, path, errors);
  if (record === null) return null;
  const kind = record["kind"];
  if (typeof kind !== "string") {
    pushError(errors, "INVALID_TYPE", `${path}/kind`, "expected an evidence kind");
    return null;
  }

  if (kind === "contract") {
    enforceExactKeys(record, path, ["kind", "pointer", "valueSha256"], errors);
    const pointer = boundedString(record["pointer"], `${path}/pointer`, errors, 256);
    const valueSha256 = sha256(record["valueSha256"], `${path}/valueSha256`, errors);
    if (pointer !== null && !compiled.pointers.has(pointer)) {
      pushError(errors, "UNKNOWN_CONTRACT_POINTER", `${path}/pointer`, "pointer is not present in the contract index");
    }
    return pointer !== null && valueSha256 !== null && compiled.pointers.has(pointer)
      ? groundEvidence({ kind, pointer, valueSha256 }, path, compiled, errors)
      : null;
  }

  if (kind === "dom_text") {
    enforceExactKeys(record, path, ["kind", "frameId", "sectionId", "excerpt", "textSha256"], errors);
    const frameId = boundedString(record["frameId"], `${path}/frameId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const sectionId = boundedString(record["sectionId"], `${path}/sectionId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const excerpt = boundedString(record["excerpt"], `${path}/excerpt`, errors, 240);
    const textSha256 = sha256(record["textSha256"], `${path}/textSha256`, errors);
    const frame = validateFrame(frameId, `${path}/frameId`, expectedRouteId, compiled, errors);
    const sectionValid = validateEvidenceSection(sectionId, `${path}/sectionId`, frame, findingSectionIds, errors);
    return frameId !== null && sectionId !== null && excerpt !== null && textSha256 !== null && frame !== null && sectionValid
      ? groundEvidence({ kind, frameId, sectionId, excerpt, textSha256 }, path, compiled, errors)
      : null;
  }

  if (kind === "region") {
    enforceExactKeys(record, path, ["kind", "frameId", "sectionId", "screenshotSha256", "box"], errors);
    const frameId = boundedString(record["frameId"], `${path}/frameId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const sectionId = boundedString(record["sectionId"], `${path}/sectionId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const screenshotSha256 = sha256(record["screenshotSha256"], `${path}/screenshotSha256`, errors);
    const frame = validateFrame(frameId, `${path}/frameId`, expectedRouteId, compiled, errors);
    const sectionValid = validateEvidenceSection(sectionId, `${path}/sectionId`, frame, findingSectionIds, errors);
    const boxRecord = asRecord(record["box"], `${path}/box`, errors);
    let box: RegionEvidence["box"] | null = null;
    if (boxRecord !== null) {
      enforceExactKeys(boxRecord, `${path}/box`, ["x", "y", "width", "height"], errors);
      const x = finiteNumber(boxRecord["x"], `${path}/box/x`, errors, true);
      const y = finiteNumber(boxRecord["y"], `${path}/box/y`, errors, true);
      const width = finiteNumber(boxRecord["width"], `${path}/box/width`, errors, false);
      const height = finiteNumber(boxRecord["height"], `${path}/box/height`, errors, false);
      if (x !== null && y !== null && width !== null && height !== null) box = { x, y, width, height };
    }
    return frameId !== null && sectionId !== null && screenshotSha256 !== null && frame !== null && sectionValid && box !== null
      ? groundEvidence({ kind, frameId, sectionId, screenshotSha256, box }, path, compiled, errors)
      : null;
  }

  if (kind === "motion_trace") {
    enforceExactKeys(record, path, ["kind", "frameId", "motionId", "sampleIndexes", "observedProperties"], errors);
    const frameId = boundedString(record["frameId"], `${path}/frameId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const motionId = boundedString(record["motionId"], `${path}/motionId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const sampleIndexes = integerArray(record["sampleIndexes"], `${path}/sampleIndexes`, errors);
    const observedProperties = uniqueStrings(record["observedProperties"], `${path}/observedProperties`, errors, 1, 8, 64);
    const frame = validateFrame(frameId, `${path}/frameId`, expectedRouteId, compiled, errors);
    let motionValid = false;
    if (frame !== null && motionId !== null) {
      motionValid = frame.motionIds.includes(motionId);
      if (!motionValid) pushError(errors, "UNKNOWN_MOTION", `${path}/motionId`, "motion id is not present for this frame");
    }
    return frameId !== null && motionId !== null && sampleIndexes !== null && observedProperties !== null && frame !== null && motionValid
      ? groundEvidence({ kind, frameId, motionId, sampleIndexes, observedProperties }, path, compiled, errors)
      : null;
  }

  if (kind === "asset") {
    enforceExactKeys(record, path, ["kind", "frameId", "sectionId", "contentSha256", "provenance"], errors);
    const frameId = boundedString(record["frameId"], `${path}/frameId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const sectionId = boundedString(record["sectionId"], `${path}/sectionId`, errors, 128, { pattern: SAFE_ID_PATTERN });
    const contentSha256 = sha256(record["contentSha256"], `${path}/contentSha256`, errors, true);
    const provenance = enumValue<TasteAssetProvenance>(record["provenance"], PROVENANCE_SET, `${path}/provenance`, errors);
    const frame = validateFrame(frameId, `${path}/frameId`, expectedRouteId, compiled, errors);
    const sectionValid = validateEvidenceSection(sectionId, `${path}/sectionId`, frame, findingSectionIds, errors);
    return frameId !== null && sectionId !== null && provenance !== null && frame !== null && sectionValid
      ? groundEvidence({ kind, frameId, sectionId, contentSha256, provenance }, path, compiled, errors)
      : null;
  }

  pushError(errors, "INVALID_VALUE", `${path}/kind`, "evidence kind is outside the closed vocabulary");
  return null;
}

function finiteNumber(value: unknown, path: string, errors: TastePolicyError[], zeroAllowed: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushError(errors, "INVALID_TYPE", path, "expected a finite number");
    return null;
  }
  if ((zeroAllowed && value < 0) || (!zeroAllowed && value <= 0)) {
    pushError(errors, "INVALID_VALUE", path, zeroAllowed ? "value cannot be negative" : "value must be positive");
    return null;
  }
  return value;
}

function integerArray(value: unknown, path: string, errors: TastePolicyError[]): readonly number[] | null {
  if (!Array.isArray(value)) {
    pushError(errors, "INVALID_TYPE", path, "expected an array");
    return null;
  }
  if (value.length < 1 || value.length > 8) pushError(errors, "LIMIT_EXCEEDED", path, "array must contain 1-8 values");
  const output: number[] = [];
  const seen = new Set<number>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) {
      pushError(errors, "INVALID_VALUE", `${path}/${String(index)}`, "sample index must be a non-negative safe integer");
    } else if (seen.has(item)) {
      pushError(errors, "DUPLICATE_VALUE", `${path}/${String(index)}`, "sample index must be unique");
    } else {
      seen.add(item);
      output.push(item);
    }
  }
  return output;
}

function validateEvidenceSection(
  sectionId: string | null,
  path: string,
  frame: TasteFrameIndex | null,
  findingSectionIds: ReadonlySet<string> | null,
  errors: TastePolicyError[],
): boolean {
  if (sectionId === null) return false;
  if (frame === null || !frame.sectionIds.includes(sectionId)) {
    pushError(errors, "UNKNOWN_SECTION", path, "section is not present in this frame");
    return false;
  }
  if (findingSectionIds !== null && !findingSectionIds.has(sectionId)) {
    pushError(errors, "EVIDENCE_SECTION_MISMATCH", path, "evidence section is outside the finding scope");
    return false;
  }
  return true;
}

function evidenceIdentity(evidence: TasteEvidence): string {
  return JSON.stringify(evidence);
}

/** Rejects a diagnosis whose only claim is a stylistic preference. */
export function isPreferenceOnlyDiagnosis(diagnosis: string): boolean {
  const normalized = diagnosis.trim().toLowerCase();
  const preference = /\b(?:i prefer|i like|i dislike|not my taste|would look better|would feel better|make it pop|more modern|more premium|more dynamic|more interesting|too boring|looks dated|feels dated)\b/u;
  if (!preference.test(normalized)) return false;
  const observable = /\b(?:repeat|same layout|missing|mismatch|contradict|overlap|clip|overflow|unreadable|contrast|compete|order|provenance|source|placeholder|undeclared|active under reduced motion|content lost|section job|proof|hierarchy|frame|pixel|coordinate)\b/u;
  return !observable.test(normalized);
}

function validateFinding(
  value: unknown,
  path: string,
  compiled: CompiledIndex,
  errors: TastePolicyError[],
): TasteFindingV1 | null {
  const record = asRecord(value, path, errors);
  if (record === null) return null;
  enforceExactKeys(record, path, ["id", "category", "code", "routeId", "sectionIds", "diagnosis", "revision", "evidence"], errors);

  const id = boundedString(record["id"], `${path}/id`, errors, 96, { pattern: SAFE_ID_PATTERN });
  const category = enumValue<TasteCategory>(record["category"], CATEGORY_SET, `${path}/category`, errors);
  const code = enumValue<TasteFindingCode>(record["code"], CODE_SET, `${path}/code`, errors);
  if (category !== null && code !== null && TASTE_CODE_CATEGORY[code] !== category) {
    pushError(errors, "CATEGORY_CODE_MISMATCH", `${path}/code`, `code belongs to ${TASTE_CODE_CATEGORY[code]}`);
  }
  const routeId = boundedString(record["routeId"], `${path}/routeId`, errors, 128, { pattern: SAFE_ID_PATTERN });
  const sectionIds = uniqueStrings(record["sectionIds"], `${path}/sectionIds`, errors, 1, 8);
  const diagnosis = boundedString(record["diagnosis"], `${path}/diagnosis`, errors, 600);
  const revision = boundedString(record["revision"], `${path}/revision`, errors, 600);
  if (diagnosis !== null && isPreferenceOnlyDiagnosis(diagnosis)) {
    pushError(errors, "PREFERENCE_ONLY_DIAGNOSIS", `${path}/diagnosis`, "diagnosis states a preference without an observable failure");
  }

  const routeSections = routeId === null ? undefined : compiled.routes.get(routeId);
  if (routeId !== null && routeSections === undefined) pushError(errors, "UNKNOWN_ROUTE", `${path}/routeId`, "route is not present in the contract index");
  if (sectionIds !== null && routeSections !== undefined) {
    for (const [index, sectionId] of sectionIds.entries()) {
      if (!routeSections.has(sectionId)) {
        pushError(errors, "SECTION_ROUTE_MISMATCH", `${path}/sectionIds/${String(index)}`, "section is not present on this route");
      }
    }
  }

  const evidenceValue = record["evidence"];
  const evidence: TasteEvidence[] = [];
  if (!Array.isArray(evidenceValue)) pushError(errors, "INVALID_TYPE", `${path}/evidence`, "expected an array");
  else {
    if (evidenceValue.length < MIN_TASTE_EVIDENCE_PER_FINDING || evidenceValue.length > MAX_TASTE_EVIDENCE_PER_FINDING) {
      pushError(errors, "LIMIT_EXCEEDED", `${path}/evidence`, "evidence array must contain 2-8 references");
    }
    const identities = new Set<string>();
    for (const [index, item] of evidenceValue.entries()) {
      const parsed = validateEvidence(
        item,
        `${path}/evidence/${String(index)}`,
        routeId,
        sectionIds === null ? null : new Set(sectionIds),
        compiled,
        errors,
      );
      if (parsed === null) continue;
      const identity = evidenceIdentity(parsed);
      if (identities.has(identity)) pushError(errors, "DUPLICATE_VALUE", `${path}/evidence/${String(index)}`, "evidence references must be distinct");
      else {
        identities.add(identity);
        evidence.push(parsed);
      }
    }
    if (evidence.length < MIN_TASTE_EVIDENCE_PER_FINDING) {
      pushError(errors, "TOO_FEW_GROUNDED_EVIDENCE", `${path}/evidence`, "finding requires at least two valid, distinct evidence references");
    }
  }

  if (
    id === null ||
    category === null ||
    code === null ||
    routeId === null ||
    sectionIds === null ||
    diagnosis === null ||
    revision === null ||
    routeSections === undefined ||
    TASTE_CODE_CATEGORY[code] !== category ||
    evidence.length < MIN_TASTE_EVIDENCE_PER_FINDING ||
    isPreferenceOnlyDiagnosis(diagnosis)
  ) return null;

  return { id, category, code, routeId, sectionIds, diagnosis, revision, evidence };
}

/** Parse the entire model turn. Markdown fences or prose before/after JSON fail. */
export function parseTasteCriticOutput(text: string, index: TasteEvidenceIndex): TastePolicyParseResult {
  const compiled = compileIndex(index);
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim()) as unknown;
  } catch {
    return { ok: false, errors: [{ code: "INVALID_JSON", path: "/", message: "critic turn must be exactly one JSON object" }] };
  }

  const errors: TastePolicyError[] = [];
  const record = asRecord(raw, "", errors);
  if (record === null) return { ok: false, errors: sortedErrors(errors) };
  enforceExactKeys(record, "", ["schemaVersion", "contractHash", "renderManifestHash", "findings"], errors);

  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== TASTE_POLICY_SCHEMA_VERSION) pushError(errors, "INVALID_VALUE", "/schemaVersion", "schemaVersion must equal 1");
  const contractHash = sha256(record["contractHash"], "/contractHash", errors);
  const renderManifestHash = sha256(record["renderManifestHash"], "/renderManifestHash", errors);
  if (contractHash !== null && contractHash !== index.contractHash) {
    pushError(errors, "WRONG_CONTRACT_HASH", "/contractHash", "contract hash does not match the injected index");
  }
  if (renderManifestHash !== null && renderManifestHash !== index.renderManifestHash) {
    pushError(errors, "WRONG_RENDER_MANIFEST_HASH", "/renderManifestHash", "render manifest hash does not match the injected index");
  }

  const findingsValue = record["findings"];
  const findings: TasteFindingV1[] = [];
  if (!Array.isArray(findingsValue)) pushError(errors, "INVALID_TYPE", "/findings", "expected an array");
  else {
    if (findingsValue.length > MAX_TASTE_FINDINGS) pushError(errors, "LIMIT_EXCEEDED", "/findings", "at most 10 findings are allowed");
    const ids = new Set<string>();
    const categoryCounts = new Map<TasteCategory, number>();
    for (const [position, item] of findingsValue.entries()) {
      const itemRecord = typeof item === "object" && item !== null && !Array.isArray(item) ? item as UnknownRecord : null;
      const rawId = itemRecord?.["id"];
      if (typeof rawId === "string") {
        if (ids.has(rawId)) pushError(errors, "DUPLICATE_FINDING_ID", `/findings/${String(position)}/id`, "finding id must be unique");
        ids.add(rawId);
      }
      const rawCategory = itemRecord?.["category"];
      if (typeof rawCategory === "string" && CATEGORY_SET.has(rawCategory)) {
        const category = rawCategory as TasteCategory;
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
      const finding = validateFinding(item, `/findings/${String(position)}`, compiled, errors);
      if (finding !== null) findings.push(finding);
    }
    for (const [category, count] of categoryCounts) {
      if (count > MAX_TASTE_FINDINGS_PER_CATEGORY) {
        pushError(errors, "LIMIT_EXCEEDED", `/findings`, `category ${category} has ${String(count)} findings; maximum is 2`);
      }
    }
  }

  if (errors.length > 0 || contractHash === null || renderManifestHash === null || schemaVersion !== 1) {
    return { ok: false, errors: sortedErrors(errors) };
  }
  return {
    ok: true,
    output: { schemaVersion, contractHash, renderManifestHash, findings },
  };
}

function assertPromptText(value: string, label: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum) throw new Error(`${label} must contain 1-${String(maximum)} characters`);
  const forbiddenBytes = /(?:data:image\/|;base64,|\x00|[A-Za-z0-9+/]{256,}={0,2})/u;
  const sourceMarkup = /<(?:html|body|script|style|div|section)\b|\b(?:import|export|function|const|let|var)\s+[A-Za-z_$]/u;
  if (forbiddenBytes.test(value) || sourceMarkup.test(value)) throw new Error(`${label} must be a bounded observation, not source or image bytes`);
}

function validatePromptFact(fact: TastePromptFact, position: number, compiled: CompiledIndex): void {
  assertPromptText(fact.id, `fact ${String(position)} id`, 96);
  assertPromptText(fact.observation, `fact ${String(position)} observation`, 320);
  const errors: TastePolicyError[] = [];
  const evidence = validateEvidence(fact.evidence, `/facts/${String(position)}/evidence`, null, null, compiled, errors);
  if (evidence === null || errors.length > 0) {
    const first = sortedErrors(errors)[0];
    throw new Error(`Invalid prompt fact evidence: ${first?.code ?? "UNKNOWN"} at ${first?.path ?? "/"}`);
  }
}

/**
 * Builds one bounded, tool-less critic turn from host-projected facts.
 * The prompt contains hashes and references, never source files or image bytes.
 */
export function buildTasteCriticPrompt(input: TasteCriticPromptInput): string {
  const compiled = compileIndex(input.evidenceIndex);
  if (input.facts.length > MAX_TASTE_PROMPT_FACTS) throw new Error("Taste critic prompt accepts at most 48 facts");
  const factIds = new Set<string>();
  for (const [position, fact] of input.facts.entries()) {
    validatePromptFact(fact, position, compiled);
    if (factIds.has(fact.id)) throw new Error(`Duplicate taste prompt fact id: ${fact.id}`);
    factIds.add(fact.id);
  }
  if (input.intentionalExceptions.length > 16) throw new Error("Taste critic prompt accepts at most 16 intentional exceptions");
  for (const [position, exception] of input.intentionalExceptions.entries()) {
    if (!EXCEPTION_SET.has(exception.rule)) throw new Error(`Unknown intentional exception at ${String(position)}`);
    assertPromptText(exception.rationale, `exception ${String(position)} rationale`, 320);
    if (exception.sectionIds.length < 1 || exception.sectionIds.length > 8) throw new Error("Intentional exception must name 1-8 sections");
    for (const sectionId of exception.sectionIds) {
      if (![...compiled.routes.values()].some((sections) => sections.has(sectionId))) {
        throw new Error(`Intentional exception refers to unknown section ${sectionId}`);
      }
    }
  }

  const payload = {
    contractHash: input.evidenceIndex.contractHash,
    renderManifestHash: input.evidenceIndex.renderManifestHash,
    facts: input.facts,
    intentionalExceptions: input.intentionalExceptions,
  };
  const prompt = `You are an independent rendered-interface taste critic. This is one tool-less turn. Use only the bounded host facts below; do not infer unseen source code, fetch assets, or request tools.

Judge observable coherence against the project's declared intent. Do not impose an aesthetic monoculture: asymmetry, symmetry, serif, sans serif, light, dark, restrained motion, expressive motion, minimal density and high density can all be correct. Never penalize a declared intentional exception by itself. Challenge an exception only when the supplied evidence shows that its stated rationale fails in the named section.

Look only for these failure families:
- copy: generic copy, job mismatch, missing proof, register drift, or repetition;
- layout: repeated section grammar, unclear section job, or drift from the contract;
- motion: undeclared motion, purpose mismatch, or placement that does not support the content;
- imagery: unknown provenance, intent mismatch, or placeholder media;
- hierarchy: flattened hierarchy or competing primary actions;
- mobile: broken reflow, wrong content order, or overflow;
- reduced_motion: animation remains active or content disappears when reduced motion is requested.

Evidence rules:
- Return a finding only for an observable failure supported by at least two distinct canonical evidence objects from facts.
- Copy canonical evidence objects exactly. Never invent a frame, section, motion, pointer, hash, coordinate or excerpt.
- A stylistic preference (for example "more modern", "more premium", "make it pop", or "I prefer asymmetry") is not a diagnosis.
- Maximum 10 findings total and 2 per category. An empty findings array is correct when evidence is insufficient.
- category and code must match the closed vocabulary.

Return exactly one JSON object and nothing else: no Markdown fence, score, severity, summary, commentary, or prose verdict. The object must have exactly these keys:
{"schemaVersion":1,"contractHash":"${input.evidenceIndex.contractHash}","renderManifestHash":"${input.evidenceIndex.renderManifestHash}","findings":[{"id":"stable-id","category":"copy|layout|motion|imagery|hierarchy|mobile|reduced_motion","code":"one allowed code","routeId":"indexed route","sectionIds":["indexed section"],"diagnosis":"observable failure only","revision":"specific bounded correction preserving project intent","evidence":[{"kind":"one canonical evidence object copied from facts"},{"kind":"a second canonical evidence object copied from facts"}]}]}

Allowed code-to-category map:
${JSON.stringify(TASTE_CODE_CATEGORY)}

Host packet (references and observations only; no source or image bytes):
${JSON.stringify(payload)}`;

  if (prompt.length > MAX_TASTE_PROMPT_CHARS) throw new Error(`Taste critic prompt exceeds ${String(MAX_TASTE_PROMPT_CHARS)} characters`);
  return prompt;
}
