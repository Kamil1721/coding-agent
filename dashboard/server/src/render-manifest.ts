import { canonicalJson, sha256Hex } from "./creative-contract.js";
import type { CreativeContractV1, CreativeMotionV1, RequiredRenderState } from "./creative-contract.js";

export const RENDER_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_RENDER_CAPTURES = 2_000;
export const MAX_RENDER_MOTION_TRACES = 400;
export const MAX_RENDER_ISSUES = 400;

export const RENDER_PROFILE_IDS = ["desktop", "mobile", "reduced_motion", "no_media"] as const;
export type RenderProfileId = (typeof RENDER_PROFILE_IDS)[number];
export const MEDIA_STATES = ["enabled", "disabled"] as const;
export type RenderMediaState = (typeof MEDIA_STATES)[number];
export const REDUCED_MOTION_STATES = ["no_preference", "reduce"] as const;
export type RenderReducedMotionState = (typeof REDUCED_MOTION_STATES)[number];

export const RENDER_ISSUE_CODES = [
  "PAGE_ERROR", "CONSOLE_ERROR", "BROKEN_NAVIGATION", "CAPTURE_FAILED", "SECTION_NOT_FOUND", "MOTION_NOT_OBSERVED",
  "HORIZONTAL_OVERFLOW", "REDUCED_MOTION_ACTIVE", "NO_MEDIA_CONTENT_LOST",
] as const;
export type RenderIssueCode = (typeof RENDER_ISSUE_CODES)[number];
export const RENDER_ISSUE_SEVERITIES = ["blocking", "warning"] as const;
export type RenderIssueSeverity = (typeof RENDER_ISSUE_SEVERITIES)[number];

export const RENDER_ASSET_PROVENANCE = ["matched", "unknown", "forbidden_remote", "missing"] as const;
export type RenderAssetProvenance = (typeof RENDER_ASSET_PROVENANCE)[number];

export const MOTION_FALLBACK_STATES = ["not_applicable", "static", "instant", "content_equivalent", "static_asset", "active", "content_lost"] as const;
export type MotionFallbackState = (typeof MOTION_FALLBACK_STATES)[number];

export interface RenderProfileV1 {
  readonly id: RenderProfileId;
  readonly viewport: { readonly width: number; readonly height: number; readonly deviceScaleFactor: number };
  readonly reducedMotion: RenderReducedMotionState;
  readonly media: RenderMediaState;
}

export const REQUIRED_RENDER_PROFILES: Readonly<Record<RenderProfileId, RenderProfileV1>> = Object.freeze({
  desktop: Object.freeze({ id: "desktop", viewport: Object.freeze({ width: 1440, height: 1000, deviceScaleFactor: 1 }), reducedMotion: "no_preference", media: "enabled" }),
  mobile: Object.freeze({ id: "mobile", viewport: Object.freeze({ width: 390, height: 844, deviceScaleFactor: 1 }), reducedMotion: "no_preference", media: "enabled" }),
  reduced_motion: Object.freeze({ id: "reduced_motion", viewport: Object.freeze({ width: 1440, height: 1000, deviceScaleFactor: 1 }), reducedMotion: "reduce", media: "enabled" }),
  no_media: Object.freeze({ id: "no_media", viewport: Object.freeze({ width: 1440, height: 1000, deviceScaleFactor: 1 }), reducedMotion: "no_preference", media: "disabled" }),
});

export interface RenderDomTextV1 { readonly excerpt: string; readonly textSha256: string; }
export interface RenderRegionV1 {
  readonly id: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}
export interface RenderAssetV1 { readonly contentSha256: string | null; readonly provenance: RenderAssetProvenance; }

export interface RenderCaptureV1 {
  readonly id: string;
  readonly profileId: RenderProfileId;
  readonly routeId: string;
  readonly sectionId: string;
  readonly state: RequiredRenderState;
  readonly urlPath: string;
  readonly screenshotPath: string;
  readonly screenshotSha256: string;
  readonly domText: readonly RenderDomTextV1[];
  readonly regions: readonly RenderRegionV1[];
  readonly assets: readonly RenderAssetV1[];
}

export interface RenderMotionTraceV1 {
  readonly id: string;
  readonly motionId: string;
  readonly captureId: string;
  readonly profileId: RenderProfileId;
  readonly routeId: string;
  readonly sectionId: string;
  readonly sampleIndexes: readonly number[];
  readonly observedProperties: readonly ("opacity" | "transform")[];
  readonly fallbackState: MotionFallbackState;
}

export interface RenderIssueV1 {
  readonly code: RenderIssueCode;
  readonly severity: RenderIssueSeverity;
  readonly profileId: RenderProfileId;
  readonly routeId: string;
  readonly sectionId: string | null;
  readonly motionId: string | null;
  readonly evidenceSha256: string;
}

export interface RenderManifestV1 {
  readonly schemaVersion: typeof RENDER_MANIFEST_SCHEMA_VERSION;
  readonly contractHash: string;
  readonly artifactHash: string;
  readonly iteration: number;
  readonly profiles: readonly RenderProfileV1[];
  readonly captures: readonly RenderCaptureV1[];
  readonly motionTraces: readonly RenderMotionTraceV1[];
  readonly issues: readonly RenderIssueV1[];
}

export interface RenderManifestBinding {
  readonly contract: CreativeContractV1;
  readonly contractHash: string;
  readonly artifactHash: string;
}

export type RenderManifestErrorCode =
  | "INVALID_JSON" | "INVALID_ROOT" | "UNKNOWN_KEY" | "MISSING_KEY" | "INVALID_TYPE" | "INVALID_VALUE" | "LIMIT_EXCEEDED"
  | "WRONG_CONTRACT_HASH" | "WRONG_ARTIFACT_HASH" | "DUPLICATE_ID" | "DUPLICATE_VALUE" | "PROFILE_MISSING"
  | "PROFILE_DUPLICATE" | "PROFILE_CONFIGURATION_MISMATCH" | "DANGLING_ROUTE" | "DANGLING_SECTION" | "DANGLING_MOTION"
  | "ROUTE_SECTION_MISMATCH" | "URL_PATH_MISMATCH" | "UNSAFE_CAPTURE_PATH" | "RAW_IMAGE_BYTES" | "REGION_OUT_OF_BOUNDS" | "CAPTURE_COVERAGE_MISSING"
  | "CAPTURE_DUPLICATE" | "STATE_NOT_REQUIRED" | "MOTION_COVERAGE_MISSING" | "MOTION_TRACE_DUPLICATE"
  | "MOTION_CAPTURE_MISMATCH" | "FALLBACK_MISMATCH" | "ISSUE_REFERENCE_INVALID";

export interface RenderManifestError { readonly code: RenderManifestErrorCode; readonly path: string; readonly message: string; }
export type RenderManifestValidationResult =
  | { readonly ok: true; readonly manifest: RenderManifestV1; readonly canonicalJson: string; readonly renderManifestHash: string }
  | { readonly ok: false; readonly errors: readonly RenderManifestError[] };

type JsonRecord = Record<string, unknown>;
interface Context { readonly errors: RenderManifestError[]; }

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SAFE_RELATIVE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const PROFILE_SET = new Set<string>(RENDER_PROFILE_IDS);
const MEDIA_SET = new Set<string>(MEDIA_STATES);
const REDUCED_SET = new Set<string>(REDUCED_MOTION_STATES);
const ISSUE_SET = new Set<string>(RENDER_ISSUE_CODES);
const SEVERITY_SET = new Set<string>(RENDER_ISSUE_SEVERITIES);
const PROVENANCE_SET = new Set<string>(RENDER_ASSET_PROVENANCE);
const FALLBACK_SET = new Set<string>(MOTION_FALLBACK_STATES);
const STATE_SET = new Set<string>(["default", "loading", "empty", "error", "interaction"]);
const PROPERTY_SET = new Set<string>(["opacity", "transform"]);

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function add(ctx: Context, code: RenderManifestErrorCode, path: string, message: string): void { ctx.errors.push({ code, path, message }); }
function sorted(errors: readonly RenderManifestError[]): readonly RenderManifestError[] {
  return [...errors].sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code));
}

function record(value: unknown, path: string, ctx: Context): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { add(ctx, path === "/" ? "INVALID_ROOT" : "INVALID_TYPE", path, "expected an object"); return null; }
  return value as JsonRecord;
}
function exact(value: JsonRecord, path: string, keys: readonly string[], ctx: Context): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value).sort(compare)) if (!allowed.has(key)) add(ctx, "UNKNOWN_KEY", `${path}/${key}`, "key is outside the closed schema");
  for (const key of keys) if (!Object.hasOwn(value, key)) add(ctx, "MISSING_KEY", `${path}/${key}`, "required key is missing");
}
function string(value: unknown, path: string, ctx: Context, max: number, nullable = false, pattern?: RegExp): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") { add(ctx, "INVALID_TYPE", path, "expected a string"); return null; }
  if (value.trim().length === 0 || value.length > max) { add(ctx, "LIMIT_EXCEEDED", path, `string must contain 1-${String(max)} characters`); return null; }
  if (pattern !== undefined && !pattern.test(value)) { add(ctx, "INVALID_VALUE", path, "string has an invalid format"); return null; }
  return value;
}
function enumString(value: unknown, path: string, ctx: Context, allowed: ReadonlySet<string>): string | null {
  const result = string(value, path, ctx, 64);
  if (result !== null && !allowed.has(result)) { add(ctx, "INVALID_VALUE", path, "value is outside the closed vocabulary"); return null; }
  return result;
}
function integer(value: unknown, path: string, ctx: Context, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) { add(ctx, "INVALID_TYPE", path, "expected a safe integer"); return null; }
  if (value < min || value > max) { add(ctx, "LIMIT_EXCEEDED", path, `integer must be ${String(min)}-${String(max)}`); return null; }
  return value;
}
function number(value: unknown, path: string, ctx: Context, positive: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) { add(ctx, "INVALID_TYPE", path, "expected a finite number"); return null; }
  if (positive ? value <= 0 : value < 0) { add(ctx, "INVALID_VALUE", path, positive ? "value must be positive" : "value cannot be negative"); return null; }
  return value;
}
function array(value: unknown, path: string, ctx: Context, min: number, max: number, visit: (item: unknown, path: string) => void): void {
  if (!Array.isArray(value)) { add(ctx, "INVALID_TYPE", path, "expected an array"); return; }
  if (value.length < min || value.length > max) add(ctx, "LIMIT_EXCEEDED", path, `array must contain ${String(min)}-${String(max)} values`);
  for (const [index, item] of value.entries()) visit(item, `${path}/${String(index)}`);
}
function stringArray(value: unknown, path: string, ctx: Context, min: number, max: number, allowed?: ReadonlySet<string>): void {
  const seen = new Set<string>();
  array(value, path, ctx, min, max, (entry, entryPath) => {
    const result = string(entry, entryPath, ctx, 64, false, allowed === undefined ? ID : undefined);
    if (result === null) return;
    if (allowed !== undefined && !allowed.has(result)) add(ctx, "INVALID_VALUE", entryPath, "value is outside the closed vocabulary");
    if (seen.has(result)) add(ctx, "DUPLICATE_VALUE", entryPath, "value must be unique");
    seen.add(result);
  });
}

function profileShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "viewport", "reducedMotion", "media"], ctx);
  enumString(item["id"], `${path}/id`, ctx, PROFILE_SET);
  const viewport = record(item["viewport"], `${path}/viewport`, ctx);
  if (viewport !== null) {
    exact(viewport, `${path}/viewport`, ["width", "height", "deviceScaleFactor"], ctx);
    integer(viewport["width"], `${path}/viewport/width`, ctx, 1, 10_000);
    integer(viewport["height"], `${path}/viewport/height`, ctx, 1, 10_000);
    number(viewport["deviceScaleFactor"], `${path}/viewport/deviceScaleFactor`, ctx, true);
  }
  enumString(item["reducedMotion"], `${path}/reducedMotion`, ctx, REDUCED_SET);
  enumString(item["media"], `${path}/media`, ctx, MEDIA_SET);
}

function domTextShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["excerpt", "textSha256"], ctx);
  string(item["excerpt"], `${path}/excerpt`, ctx, 240);
  string(item["textSha256"], `${path}/textSha256`, ctx, 64, false, HASH);
}
function regionShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "box"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID);
  const box = record(item["box"], `${path}/box`, ctx);
  if (box !== null) {
    exact(box, `${path}/box`, ["x", "y", "width", "height"], ctx);
    number(box["x"], `${path}/box/x`, ctx, false); number(box["y"], `${path}/box/y`, ctx, false);
    number(box["width"], `${path}/box/width`, ctx, true); number(box["height"], `${path}/box/height`, ctx, true);
  }
}
function assetShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["contentSha256", "provenance"], ctx);
  string(item["contentSha256"], `${path}/contentSha256`, ctx, 64, true, HASH);
  enumString(item["provenance"], `${path}/provenance`, ctx, PROVENANCE_SET);
}
function captureShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "profileId", "routeId", "sectionId", "state", "urlPath", "screenshotPath", "screenshotSha256", "domText", "regions", "assets"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID);
  enumString(item["profileId"], `${path}/profileId`, ctx, PROFILE_SET);
  string(item["routeId"], `${path}/routeId`, ctx, 128, false, ID);
  string(item["sectionId"], `${path}/sectionId`, ctx, 128, false, ID);
  enumString(item["state"], `${path}/state`, ctx, STATE_SET);
  string(item["urlPath"], `${path}/urlPath`, ctx, 256);
  const screenshotPath = string(item["screenshotPath"], `${path}/screenshotPath`, ctx, 512);
  if (screenshotPath !== null && !SAFE_RELATIVE_PATH.test(screenshotPath)) add(ctx, "UNSAFE_CAPTURE_PATH", `${path}/screenshotPath`, "capture path must be relative and cannot traverse directories");
  if (screenshotPath !== null && /(?:data:image\/|;base64,|[A-Za-z0-9+/]{256,}={0,2})/u.test(screenshotPath)) add(ctx, "RAW_IMAGE_BYTES", `${path}/screenshotPath`, "capture path cannot contain image bytes");
  string(item["screenshotSha256"], `${path}/screenshotSha256`, ctx, 64, false, HASH);
  array(item["domText"], `${path}/domText`, ctx, 0, 200, (entry, entryPath) => domTextShape(entry, entryPath, ctx));
  array(item["regions"], `${path}/regions`, ctx, 1, 40, (entry, entryPath) => regionShape(entry, entryPath, ctx));
  array(item["assets"], `${path}/assets`, ctx, 0, 40, (entry, entryPath) => assetShape(entry, entryPath, ctx));
}
function traceShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["id", "motionId", "captureId", "profileId", "routeId", "sectionId", "sampleIndexes", "observedProperties", "fallbackState"], ctx);
  string(item["id"], `${path}/id`, ctx, 128, false, ID); string(item["motionId"], `${path}/motionId`, ctx, 128, false, ID);
  string(item["captureId"], `${path}/captureId`, ctx, 128, false, ID); enumString(item["profileId"], `${path}/profileId`, ctx, PROFILE_SET);
  string(item["routeId"], `${path}/routeId`, ctx, 128, false, ID); string(item["sectionId"], `${path}/sectionId`, ctx, 128, false, ID);
  const indexes = new Set<number>();
  array(item["sampleIndexes"], `${path}/sampleIndexes`, ctx, 1, 16, (entry, entryPath) => {
    const parsed = integer(entry, entryPath, ctx, 0, 1_000_000); if (parsed === null) return;
    if (indexes.has(parsed)) add(ctx, "DUPLICATE_VALUE", entryPath, "sample index must be unique"); indexes.add(parsed);
  });
  stringArray(item["observedProperties"], `${path}/observedProperties`, ctx, 0, 2, PROPERTY_SET);
  enumString(item["fallbackState"], `${path}/fallbackState`, ctx, FALLBACK_SET);
}
function issueShape(value: unknown, path: string, ctx: Context): void {
  const item = record(value, path, ctx); if (item === null) return;
  exact(item, path, ["code", "severity", "profileId", "routeId", "sectionId", "motionId", "evidenceSha256"], ctx);
  enumString(item["code"], `${path}/code`, ctx, ISSUE_SET); enumString(item["severity"], `${path}/severity`, ctx, SEVERITY_SET);
  enumString(item["profileId"], `${path}/profileId`, ctx, PROFILE_SET); string(item["routeId"], `${path}/routeId`, ctx, 128, false, ID);
  string(item["sectionId"], `${path}/sectionId`, ctx, 128, true, ID); string(item["motionId"], `${path}/motionId`, ctx, 128, true, ID);
  string(item["evidenceSha256"], `${path}/evidenceSha256`, ctx, 64, false, HASH);
}
function manifestShape(value: unknown, ctx: Context): void {
  const item = record(value, "/", ctx); if (item === null) return;
  exact(item, "", ["schemaVersion", "contractHash", "artifactHash", "iteration", "profiles", "captures", "motionTraces", "issues"], ctx);
  if (item["schemaVersion"] !== 1) add(ctx, "INVALID_VALUE", "/schemaVersion", "schemaVersion must equal 1");
  string(item["contractHash"], "/contractHash", ctx, 64, false, HASH); string(item["artifactHash"], "/artifactHash", ctx, 64, false, HASH);
  integer(item["iteration"], "/iteration", ctx, 0, 3);
  array(item["profiles"], "/profiles", ctx, 0, 4, (entry, path) => profileShape(entry, path, ctx));
  array(item["captures"], "/captures", ctx, 1, MAX_RENDER_CAPTURES, (entry, path) => captureShape(entry, path, ctx));
  array(item["motionTraces"], "/motionTraces", ctx, 0, MAX_RENDER_MOTION_TRACES, (entry, path) => traceShape(entry, path, ctx));
  array(item["issues"], "/issues", ctx, 0, MAX_RENDER_ISSUES, (entry, path) => issueShape(entry, path, ctx));
}

function hasRawBytes(value: unknown): boolean {
  if (typeof value === "string") return /(?:data:image\/|;base64,|[A-Za-z0-9+/]{256,}={0,2})/u.test(value);
  if (Array.isArray(value)) return value.some(hasRawBytes);
  if (typeof value === "object" && value !== null) return Object.values(value as JsonRecord).some(hasRawBytes);
  return false;
}
function duplicateIds<T extends { readonly id: string }>(items: readonly T[], base: string, ctx: Context): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    if (result.has(item.id)) add(ctx, "DUPLICATE_ID", `${base}/${String(index)}/id`, "id must be unique in this collection");
    else result.set(item.id, item);
  }
  return result;
}
function expectedFallback(motion: CreativeMotionV1, profileId: RenderProfileId): MotionFallbackState {
  if (profileId === "reduced_motion") return motion.fallback.reducedMotion;
  if (profileId === "no_media") return motion.fallback.noMedia;
  return "not_applicable";
}

function semantic(manifest: RenderManifestV1, binding: RenderManifestBinding, ctx: Context): void {
  if (manifest.contractHash !== binding.contractHash) add(ctx, "WRONG_CONTRACT_HASH", "/contractHash", "manifest contract hash does not match the binding");
  if (manifest.artifactHash !== binding.artifactHash) add(ctx, "WRONG_ARTIFACT_HASH", "/artifactHash", "manifest artifact hash does not match the binding");
  const canonicalContractHash = sha256Hex(canonicalJson(binding.contract));
  if (canonicalContractHash !== binding.contractHash) throw new Error("Render manifest binding contractHash is not the canonical contract hash");
  if (!HASH.test(binding.artifactHash)) throw new Error("Render manifest binding artifactHash must be lowercase SHA-256");
  if (hasRawBytes(manifest)) add(ctx, "RAW_IMAGE_BYTES", "/", "render manifest cannot contain source or image byte payloads");

  const routes = new Map(binding.contract.routes.map((route) => [route.id, route]));
  const sections = new Map(binding.contract.sections.map((section) => [section.id, section]));
  const motions = new Map(binding.contract.motion.map((motion) => [motion.id, motion]));
  const profileMap = new Map<RenderProfileId, RenderProfileV1>();
  for (const [index, profile] of manifest.profiles.entries()) {
    if (profileMap.has(profile.id)) add(ctx, "PROFILE_DUPLICATE", `/profiles/${String(index)}/id`, "profile id must be unique");
    profileMap.set(profile.id, profile);
    const required = REQUIRED_RENDER_PROFILES[profile.id];
    if (canonicalJson(profile) !== canonicalJson(required)) add(ctx, "PROFILE_CONFIGURATION_MISMATCH", `/profiles/${String(index)}`, "profile does not match its fixed viewport, media and reduced-motion configuration");
  }
  for (const id of RENDER_PROFILE_IDS) if (!profileMap.has(id)) add(ctx, "PROFILE_MISSING", "/profiles", `required profile ${id} is missing`);

  const captures = duplicateIds(manifest.captures, "/captures", ctx);
  const captureKeys = new Set<string>();
  const evidenceCoordinates = new Map<string, Set<string>>();
  const indexEvidence = (hash: string, capture: RenderCaptureV1): void => {
    const coordinates = evidenceCoordinates.get(hash) ?? new Set<string>();
    coordinates.add(`${capture.profileId}:${capture.routeId}:${capture.sectionId}`);
    evidenceCoordinates.set(hash, coordinates);
  };
  for (const [index, capture] of manifest.captures.entries()) {
    const route = routes.get(capture.routeId);
    const section = sections.get(capture.sectionId);
    if (route === undefined) add(ctx, "DANGLING_ROUTE", `/captures/${String(index)}/routeId`, "capture route does not exist in the contract");
    if (section === undefined) add(ctx, "DANGLING_SECTION", `/captures/${String(index)}/sectionId`, "capture section does not exist in the contract");
    else if (section.routeId !== capture.routeId) add(ctx, "ROUTE_SECTION_MISMATCH", `/captures/${String(index)}/sectionId`, "capture section belongs to another route");
    if (route !== undefined && capture.urlPath !== route.path) add(ctx, "URL_PATH_MISMATCH", `/captures/${String(index)}/urlPath`, "capture URL path does not equal the immutable route path");
    if (section !== undefined && !section.requiredStates.includes(capture.state)) add(ctx, "STATE_NOT_REQUIRED", `/captures/${String(index)}/state`, "capture state is not required by the section contract");
    const key = `${capture.profileId}:${capture.routeId}:${capture.sectionId}:${capture.state}`;
    if (captureKeys.has(key)) add(ctx, "CAPTURE_DUPLICATE", `/captures/${String(index)}`, "profile, section and state capture must be unique");
    captureKeys.add(key);
    indexEvidence(capture.screenshotSha256, capture);
    for (const text of capture.domText) indexEvidence(text.textSha256, capture);
    for (const asset of capture.assets) if (asset.contentSha256 !== null) indexEvidence(asset.contentSha256, capture);
    const regionIds = new Set<string>();
    const profile = profileMap.get(capture.profileId);
    for (const [position, region] of capture.regions.entries()) {
      if (regionIds.has(region.id)) add(ctx, "DUPLICATE_ID", `/captures/${String(index)}/regions/${String(position)}/id`, "region id must be unique in its capture");
      regionIds.add(region.id);
      if (profile !== undefined && (region.box.x + region.box.width > profile.viewport.width || region.box.y + region.box.height > profile.viewport.height)) add(ctx, "REGION_OUT_OF_BOUNDS", `/captures/${String(index)}/regions/${String(position)}/box`, "region must fit inside its fixed capture viewport");
    }
  }
  for (const profileId of RENDER_PROFILE_IDS) for (const section of binding.contract.sections) for (const state of section.requiredStates) {
    const key = `${profileId}:${section.routeId}:${section.id}:${state}`;
    if (!captureKeys.has(key)) add(ctx, "CAPTURE_COVERAGE_MISSING", "/captures", `missing ${key}`);
  }

  duplicateIds(manifest.motionTraces, "/motionTraces", ctx);
  const traceKeys = new Set<string>();
  for (const [index, trace] of manifest.motionTraces.entries()) {
    const motion = motions.get(trace.motionId);
    const capture = captures.get(trace.captureId);
    if (motion === undefined) add(ctx, "DANGLING_MOTION", `/motionTraces/${String(index)}/motionId`, "trace motion does not exist in the contract");
    else {
      if (motion.routeId !== trace.routeId || motion.sectionId !== trace.sectionId) add(ctx, "MOTION_CAPTURE_MISMATCH", `/motionTraces/${String(index)}`, "trace route or section differs from its motion contract");
      if (trace.fallbackState !== expectedFallback(motion, trace.profileId)) add(ctx, "FALLBACK_MISMATCH", `/motionTraces/${String(index)}/fallbackState`, "observed fallback does not match the motion contract and profile");
    }
    if (capture === undefined || capture.profileId !== trace.profileId || capture.routeId !== trace.routeId || capture.sectionId !== trace.sectionId) add(ctx, "MOTION_CAPTURE_MISMATCH", `/motionTraces/${String(index)}/captureId`, "trace capture does not match its profile, route and section");
    const key = `${trace.profileId}:${trace.motionId}`;
    if (traceKeys.has(key)) add(ctx, "MOTION_TRACE_DUPLICATE", `/motionTraces/${String(index)}`, "motion may have one trace per required profile");
    traceKeys.add(key);
    if ((trace.profileId === "desktop" || trace.profileId === "mobile") && trace.observedProperties.length === 0) add(ctx, "MOTION_COVERAGE_MISSING", `/motionTraces/${String(index)}/observedProperties`, "active profiles require an observed safe motion property");
  }
  for (const profileId of RENDER_PROFILE_IDS) for (const motion of binding.contract.motion) if (!traceKeys.has(`${profileId}:${motion.id}`)) add(ctx, "MOTION_COVERAGE_MISSING", "/motionTraces", `missing ${profileId}:${motion.id}`);

  for (const [index, issue] of manifest.issues.entries()) {
    const section = issue.sectionId === null ? null : sections.get(issue.sectionId);
    const motion = issue.motionId === null ? null : motions.get(issue.motionId);
    if (!routes.has(issue.routeId)) add(ctx, "ISSUE_REFERENCE_INVALID", `/issues/${String(index)}/routeId`, "issue route does not exist");
    if (issue.sectionId !== null && (section === null || section === undefined || section.routeId !== issue.routeId)) add(ctx, "ISSUE_REFERENCE_INVALID", `/issues/${String(index)}/sectionId`, "issue section does not exist on this route");
    if (issue.motionId !== null && (motion === null || motion === undefined || motion.routeId !== issue.routeId || (issue.sectionId !== null && motion.sectionId !== issue.sectionId))) add(ctx, "ISSUE_REFERENCE_INVALID", `/issues/${String(index)}/motionId`, "issue motion does not match its route and section");
    const needsMotion = issue.code === "MOTION_NOT_OBSERVED" || issue.code === "REDUCED_MOTION_ACTIVE";
    const needsSection = !["PAGE_ERROR", "CONSOLE_ERROR", "BROKEN_NAVIGATION"].includes(issue.code);
    if ((needsMotion && issue.motionId === null) || (needsSection && issue.sectionId === null)) add(ctx, "ISSUE_REFERENCE_INVALID", `/issues/${String(index)}`, "issue code requires more specific evidence references");
    const coordinates = evidenceCoordinates.get(issue.evidenceSha256);
    const coordinate = `${issue.profileId}:${issue.routeId}:${issue.sectionId ?? ""}`;
    const coordinateMatches = coordinates !== undefined && (issue.sectionId === null
      ? [...coordinates].some((candidate) => candidate.startsWith(`${issue.profileId}:${issue.routeId}:`))
      : coordinates.has(coordinate));
    if (!coordinateMatches) add(ctx, "ISSUE_REFERENCE_INVALID", `/issues/${String(index)}/evidenceSha256`, "issue evidence digest is not present at the named profile, route and section");
  }
}

export function canonicalRenderManifestProjection(manifest: RenderManifestV1): RenderManifestV1 {
  const profileRank = new Map(RENDER_PROFILE_IDS.map((id, index) => [id, index]));
  const profiles = [...manifest.profiles].sort((a, b) => (profileRank.get(a.id) ?? 99) - (profileRank.get(b.id) ?? 99));
  const captures = [...manifest.captures].map((capture) => ({
    ...capture,
    domText: [...capture.domText].sort((a, b) => compare(a.textSha256, b.textSha256) || compare(a.excerpt, b.excerpt)),
    regions: [...capture.regions].sort((a, b) => compare(a.id, b.id)),
    assets: [...capture.assets].sort((a, b) => compare(`${a.provenance}:${a.contentSha256 ?? ""}`, `${b.provenance}:${b.contentSha256 ?? ""}`)),
  })).sort((a, b) => compare(a.id, b.id));
  const motionTraces = [...manifest.motionTraces].sort((a, b) => compare(a.id, b.id));
  const issues = [...manifest.issues].sort((a, b) => compare(`${a.profileId}:${a.routeId}:${a.sectionId ?? ""}:${a.motionId ?? ""}:${a.code}:${a.evidenceSha256}`, `${b.profileId}:${b.routeId}:${b.sectionId ?? ""}:${b.motionId ?? ""}:${b.code}:${b.evidenceSha256}`));
  return { ...manifest, profiles, captures, motionTraces, issues };
}

export function validateRenderManifest(text: string, binding: RenderManifestBinding): RenderManifestValidationResult {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()) as unknown; }
  catch { return { ok: false, errors: [{ code: "INVALID_JSON", path: "/", message: "manifest must be exactly one JSON object" }] }; }
  const ctx: Context = { errors: [] };
  manifestShape(raw, ctx);
  if (ctx.errors.length > 0) return { ok: false, errors: sorted(ctx.errors) };
  const manifest = raw as RenderManifestV1;
  semantic(manifest, binding, ctx);
  if (ctx.errors.length > 0) return { ok: false, errors: sorted(ctx.errors) };
  const projection = canonicalRenderManifestProjection(manifest);
  const result = canonicalJson(projection);
  return { ok: true, manifest, canonicalJson: result, renderManifestHash: sha256Hex(result) };
}
