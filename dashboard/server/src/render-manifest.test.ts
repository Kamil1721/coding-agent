import { strict as assert } from "node:assert";
import { test } from "node:test";

import { canonicalJson, compileCreativeContract, sha256Hex } from "./creative-contract.js";
import type { CreativeContractV1, CreativeEvidenceRef, CreativeSectionV1 } from "./creative-contract.js";
import { REQUIRED_RENDER_PROFILES, validateRenderManifest } from "./render-manifest.js";
import type { MotionFallbackState, RenderManifestBinding, RenderManifestV1, RenderProfileId } from "./render-manifest.js";

const SOURCE_HASH = "a".repeat(64);
const EXCERPT_HASH = "b".repeat(64);
const ARTIFACT_HASH = "c".repeat(64);
const EVIDENCE: CreativeEvidenceRef = { kind: "owner_message", locator: "message:render-brief", sha256: SOURCE_HASH, excerptSha256: EXCERPT_HASH };

function section(id: string, routeId: string, order: number, kind: "hero" | "footer", action: boolean): CreativeSectionV1 {
  const proofId = `proof-${id}`;
  return {
    id, routeId, order, kind, job: `Give ${routeId} visitors a concrete ${kind} decision.`,
    contentRefs: [{ proofId, use: "headline" }], eyebrow: null, headline: `Specific ${kind} evidence`, body: null,
    actions: action ? [{ id: `action-${id}`, label: "Start review", intent: "signup", priority: "primary", href: "/start", proofId }] : [],
    layoutFamily: kind === "hero" ? "asymmetric_split" : "footer_columns",
    visualKind: kind === "hero" ? "generated_image" : "none",
    mobile: { strategy: kind === "hero" ? "stack" : "preserve", contentOrder: ["headline", ...(kind === "hero" ? ["visual"] : []), ...(action ? ["actions"] : [])] as CreativeSectionV1["mobile"]["contentOrder"] },
    requiredStates: action ? ["default", "interaction"] : ["default"],
  };
}

function contractFixture(): CreativeContractV1 {
  const sections = [section("home-hero", "home", 0, "hero", true), section("home-footer", "home", 1, "footer", false), section("work-hero", "work", 0, "hero", false), section("work-footer", "work", 1, "footer", false)];
  return {
    schemaVersion: 1,
    contractId: "render-contract",
    designRead: { pageKind: "saas_landing", audience: "Technical owners.", vibe: "Direct and evidence-led.", aestheticFamily: "industrial", designSystem: "tailwind", displayStyle: "sans", paletteFamily: "neutral_pop", theme: "dark", thesis: "Each route makes one owner decision inspectable." },
    dials: { designVariance: 7, motionIntensity: 6, visualDensity: 5 },
    contentProof: sections.map((item) => ({ id: `proof-${item.id}`, claim: `Owner-supported claim for ${item.id}.`, status: "supported_paraphrase", evidence: EVIDENCE, allowedUses: item.actions.length > 0 ? ["headline", "action"] : ["headline"] })),
    routes: [{ id: "home", path: "/", sectionIds: ["home-hero", "home-footer"] }, { id: "work", path: "/work", sectionIds: ["work-hero", "work-footer"] }],
    sections,
    motion: [
      { id: "home-action", routeId: "home", sectionId: "home-hero", target: "primary action", purpose: "feedback", trigger: "interaction", implementation: "motion", properties: ["transform"], rationale: "Confirm activation of the primary action.", fallback: { reducedMotion: "instant", noMedia: "not_applicable" }, sourceStillKind: "none", simulationAuthorized: false },
      { id: "work-reveal", routeId: "work", sectionId: "work-hero", target: "hero copy", purpose: "hierarchy", trigger: "enter_view", implementation: "css", properties: ["opacity", "transform"], rationale: "Reveal the route thesis before the footer.", fallback: { reducedMotion: "static", noMedia: "static_asset" }, sourceStillKind: "illustration", simulationAuthorized: false },
    ],
    intentionalExceptions: [],
  };
}

function bindingFixture(): RenderManifestBinding {
  const contract = contractFixture();
  const compiled = compileCreativeContract(JSON.stringify(contract), { resolve: () => ({ sha256: SOURCE_HASH, excerptSha256: EXCERPT_HASH }) });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  return { contract, contractHash: compiled.contractHash, artifactHash: ARTIFACT_HASH };
}

function fallback(profileId: RenderProfileId, motion: CreativeContractV1["motion"][number]): MotionFallbackState {
  if (profileId === "reduced_motion") return motion.fallback.reducedMotion;
  if (profileId === "no_media") return motion.fallback.noMedia;
  return "not_applicable";
}

function manifestFixture(binding: RenderManifestBinding): RenderManifestV1 {
  const routePaths = new Map(binding.contract.routes.map((route) => [route.id, route.path]));
  const profiles = Object.values(REQUIRED_RENDER_PROFILES);
  const captures = profiles.flatMap((profile) => binding.contract.sections.flatMap((item) => item.requiredStates.map((state) => {
    const id = `${profile.id}:${item.id}:${state}`;
    return {
      id,
      profileId: profile.id,
      routeId: item.routeId,
      sectionId: item.id,
      state,
      urlPath: routePaths.get(item.routeId)!,
      screenshotPath: `captures/${profile.id}/${item.id}-${state}.png`,
      screenshotSha256: sha256Hex(`screenshot:${id}`),
      domText: [{ excerpt: item.headline, textSha256: sha256Hex(`text:${id}`) }],
      regions: [{ id: "section", box: { x: 10, y: 10, width: 300, height: 300 } }],
      assets: item.visualKind === "none" ? [] : [{ contentSha256: sha256Hex(`asset:${id}`), provenance: "matched" as const }],
    };
  })));
  const captureMap = new Map(captures.map((capture) => [`${capture.profileId}:${capture.sectionId}:${capture.state}`, capture]));
  const motionTraces = profiles.flatMap((profile) => binding.contract.motion.map((motion) => {
    const state = motion.trigger === "interaction" ? "interaction" : "default";
    const capture = captureMap.get(`${profile.id}:${motion.sectionId}:${state}`)!;
    return {
      id: `${profile.id}:${motion.id}`,
      motionId: motion.id,
      captureId: capture.id,
      profileId: profile.id,
      routeId: motion.routeId,
      sectionId: motion.sectionId,
      sampleIndexes: [0, 1],
      observedProperties: profile.id === "desktop" || profile.id === "mobile" ? motion.properties : [],
      fallbackState: fallback(profile.id, motion),
    };
  }));
  return { schemaVersion: 1, contractHash: binding.contractHash, artifactHash: binding.artifactHash, iteration: 0, profiles, captures, motionTraces, issues: [] };
}

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
function mutableManifest(binding: RenderManifestBinding): Mutable<RenderManifestV1> { return structuredClone(manifestFixture(binding)) as Mutable<RenderManifestV1>; }
function validate(manifest: RenderManifestV1, binding: RenderManifestBinding) { return validateRenderManifest(JSON.stringify(manifest), binding); }
function codes(manifest: RenderManifestV1, binding: RenderManifestBinding): readonly string[] {
  const result = validate(manifest, binding); assert.equal(result.ok, false); return result.errors.map((item) => item.code);
}

test("validates complete multi-route, multi-motion coverage and hashes a canonical projection", () => {
  const binding = bindingFixture();
  const manifest = manifestFixture(binding);
  const result = validate(manifest, binding);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.renderManifestHash, /^[a-f0-9]{64}$/u);

  const reordered = { ...manifest, profiles: [...manifest.profiles].reverse(), captures: [...manifest.captures].reverse(), motionTraces: [...manifest.motionTraces].reverse() };
  const second = validate(reordered, binding);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.renderManifestHash, result.renderManifestHash);
  assert.equal(second.canonicalJson, result.canonicalJson);
});

test("rejects prose, unknown nested keys and unknown issue vocabulary", () => {
  const binding = bindingFixture();
  const manifest = manifestFixture(binding);
  const prose = validateRenderManifest(`manifest:\n${JSON.stringify(manifest)}`, binding);
  assert.equal(prose.ok, false);
  assert.deepEqual(prose.errors.map((item) => item.code), ["INVALID_JSON"]);

  const unknown = mutableManifest(binding);
  (unknown.profiles[0]!.viewport as Record<string, unknown>)["orientation"] = "landscape";
  assert.ok(codes(unknown, binding).includes("UNKNOWN_KEY"));

  const issue = mutableManifest(binding);
  issue.issues.push({ code: "PIXEL_VIBES" as never, severity: "warning", profileId: "desktop", routeId: "home", sectionId: null, motionId: null, evidenceSha256: issue.captures[0]!.screenshotSha256 });
  assert.ok(codes(issue, binding).includes("INVALID_VALUE"));
});

test("binds the exact contract and artifact hashes", () => {
  const binding = bindingFixture();
  const contract = mutableManifest(binding); contract.contractHash = "d".repeat(64);
  assert.ok(codes(contract, binding).includes("WRONG_CONTRACT_HASH"));
  const artifact = mutableManifest(binding); artifact.artifactHash = "e".repeat(64);
  assert.ok(codes(artifact, binding).includes("WRONG_ARTIFACT_HASH"));
});

test("requires all four profiles with fixed viewport, media and reduced-motion settings", () => {
  const binding = bindingFixture();
  const missing = mutableManifest(binding); missing.profiles.pop();
  const missingCodes = codes(missing, binding);
  assert.ok(missingCodes.includes("PROFILE_MISSING"));

  const viewport = mutableManifest(binding); viewport.profiles[0]!.viewport.width = 1280;
  assert.ok(codes(viewport, binding).includes("PROFILE_CONFIGURATION_MISMATCH"));
  const reduced = mutableManifest(binding); reduced.profiles.find((item) => item.id === "reduced_motion")!.reducedMotion = "no_preference";
  assert.ok(codes(reduced, binding).includes("PROFILE_CONFIGURATION_MISMATCH"));
});

test("rejects unknown route, section and motion references", () => {
  const binding = bindingFixture();
  const route = mutableManifest(binding); route.captures[0]!.routeId = "missing";
  assert.ok(codes(route, binding).includes("DANGLING_ROUTE"));
  const section = mutableManifest(binding); section.captures[0]!.sectionId = "missing";
  assert.ok(codes(section, binding).includes("DANGLING_SECTION"));
  const motion = mutableManifest(binding); motion.motionTraces[0]!.motionId = "missing";
  assert.ok(codes(motion, binding).includes("DANGLING_MOTION"));
});

test("rejects absolute, traversing and raw-byte capture paths", () => {
  const binding = bindingFixture();
  const absolute = mutableManifest(binding); absolute.captures[0]!.screenshotPath = "/tmp/capture.png";
  assert.ok(codes(absolute, binding).includes("UNSAFE_CAPTURE_PATH"));
  const traversal = mutableManifest(binding); traversal.captures[0]!.screenshotPath = "../capture.png";
  assert.ok(codes(traversal, binding).includes("UNSAFE_CAPTURE_PATH"));
  const bytes = mutableManifest(binding); bytes.captures[0]!.screenshotPath = "data:image/png;base64,AAAA";
  const byteCodes = codes(bytes, binding);
  assert.ok(byteCodes.includes("UNSAFE_CAPTURE_PATH"));
  assert.ok(byteCodes.includes("RAW_IMAGE_BYTES"));
});

test("enforces capture state coverage, uniqueness, URL binding and coordinate bounds", () => {
  const binding = bindingFixture();
  const missing = mutableManifest(binding); missing.captures.pop();
  assert.ok(codes(missing, binding).includes("CAPTURE_COVERAGE_MISSING"));
  const duplicate = mutableManifest(binding); duplicate.captures.push(structuredClone(duplicate.captures[0]!)); duplicate.captures.at(-1)!.id = "duplicate-coordinate";
  assert.ok(codes(duplicate, binding).includes("CAPTURE_DUPLICATE"));
  const state = mutableManifest(binding); state.captures[0]!.state = "error";
  assert.ok(codes(state, binding).includes("STATE_NOT_REQUIRED"));
  const url = mutableManifest(binding); url.captures[0]!.urlPath = "/wrong";
  assert.ok(codes(url, binding).includes("URL_PATH_MISMATCH"));
  const bounds = mutableManifest(binding); bounds.captures[0]!.regions[0]!.box.width = 2_000;
  assert.ok(codes(bounds, binding).includes("REGION_OUT_OF_BOUNDS"));
});

test("enforces motion trace coverage, capture identity and declared fallbacks", () => {
  const binding = bindingFixture();
  const missing = mutableManifest(binding); missing.motionTraces.pop();
  assert.ok(codes(missing, binding).includes("MOTION_COVERAGE_MISSING"));
  const duplicate = mutableManifest(binding); duplicate.motionTraces.push(structuredClone(duplicate.motionTraces[0]!)); duplicate.motionTraces.at(-1)!.id = "trace-copy";
  assert.ok(codes(duplicate, binding).includes("MOTION_TRACE_DUPLICATE"));
  const capture = mutableManifest(binding); capture.motionTraces[0]!.captureId = capture.captures.find((item) => item.sectionId === "work-hero")!.id;
  assert.ok(codes(capture, binding).includes("MOTION_CAPTURE_MISMATCH"));
  const fallbackState = mutableManifest(binding); fallbackState.motionTraces.find((item) => item.profileId === "reduced_motion")!.fallbackState = "active";
  assert.ok(codes(fallbackState, binding).includes("FALLBACK_MISMATCH"));
});

test("requires issue coordinates and a digest from captured evidence", () => {
  const binding = bindingFixture();
  const valid = mutableManifest(binding);
  const capture = valid.captures.find((item) => item.profileId === "mobile" && item.sectionId === "home-hero")!;
  valid.issues.push({ code: "HORIZONTAL_OVERFLOW", severity: "blocking", profileId: "mobile", routeId: "home", sectionId: "home-hero", motionId: null, evidenceSha256: capture.screenshotSha256 });
  assert.equal(validate(valid, binding).ok, true);

  const bad = mutableManifest(binding);
  bad.issues.push({ code: "MOTION_NOT_OBSERVED", severity: "warning", profileId: "desktop", routeId: "home", sectionId: "home-hero", motionId: null, evidenceSha256: "f".repeat(64) });
  const badCodes = codes(bad, binding);
  assert.ok(badCodes.includes("ISSUE_REFERENCE_INVALID"));

  const wrongCoordinate = mutableManifest(binding);
  const workCapture = wrongCoordinate.captures.find((item) => item.profileId === "mobile" && item.sectionId === "work-hero")!;
  wrongCoordinate.issues.push({ code: "HORIZONTAL_OVERFLOW", severity: "blocking", profileId: "mobile", routeId: "home", sectionId: "home-hero", motionId: null, evidenceSha256: workCapture.screenshotSha256 });
  assert.ok(codes(wrongCoordinate, binding).includes("ISSUE_REFERENCE_INVALID"));
});

test("canonical projection is JSON-key stable as well as collection-order stable", () => {
  const binding = bindingFixture();
  const manifest = manifestFixture(binding);
  const baseline = validate(manifest, binding);
  assert.equal(baseline.ok, true);
  const raw = JSON.parse(canonicalJson(manifest)) as RenderManifestV1;
  const canonical = validate(raw, binding);
  assert.equal(canonical.ok, true);
  assert.equal(canonical.renderManifestHash, baseline.renderManifestHash);
});
