import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { canonicalJson, sha256Hex } from "./creative-contract.js";
import type {
  CreativeContractV1,
  CreativeMotionV1,
  CreativeRouteV1,
  CreativeSectionV1,
  RequiredRenderState,
} from "./creative-contract.js";
import type { ActivePreview } from "./preview.js";
import {
  RENDER_PROFILE_IDS,
  REQUIRED_RENDER_PROFILES,
  validateRenderManifest,
} from "./render-manifest.js";
import type {
  MotionFallbackState,
  RenderAssetProvenance,
  RenderAssetV1,
  RenderCaptureV1,
  RenderIssueCode,
  RenderIssueSeverity,
  RenderIssueV1,
  RenderManifestBinding,
  RenderManifestV1,
  RenderMotionTraceV1,
  RenderProfileId,
  RenderProfileV1,
} from "./render-manifest.js";
import type {
  TasteCriticPromptInput,
  TasteEvidence,
  TasteEvidenceIndex,
  TastePromptFact,
} from "./taste-policy.js";

export const CREATIVE_ROUTE_ATTRIBUTE = "data-creative-route";
export const CREATIVE_SECTION_ATTRIBUTE = "data-creative-section";
export const CREATIVE_MOTION_ATTRIBUTE = "data-motion-id";

export const CREATIVE_NAVIGATION_TIMEOUT_MS = 20_000;
export const CREATIVE_SCREENSHOT_TIMEOUT_MS = 10_000;
export const CREATIVE_STATE_SETTLE_MS = 120;
export const CREATIVE_INTERACTION_SETTLE_MS = 220;
export const CREATIVE_HOVER_TIMEOUT_MS = 1_000;
export const MAX_CREATIVE_ISSUES = 64;
export const MAX_CREATIVE_EVENTS_PER_KIND = 8;
export const MAX_CREATIVE_TEXT_PER_CAPTURE = 8;
export const MAX_CREATIVE_ASSETS_PER_CAPTURE = 8;
export const MAX_CREATIVE_FACTS = 48;
export const MAX_CREATIVE_TOTAL_BYTES = 60_000_000;

export interface CreativeRenderConsoleMessage {
  type(): string;
  text(): string;
}

export interface CreativeRenderRequestFailure {
  errorText?: string;
}

export interface CreativeRenderRequest {
  url(): string;
  resourceType(): string;
  failure(): CreativeRenderRequestFailure | null;
}

export interface CreativeRenderRoute {
  request(): CreativeRenderRequest;
  continue(): Promise<unknown>;
  abort(errorCode?: string): Promise<unknown>;
}

export interface CreativeRenderResponse {
  status(): number;
  url(): string;
}

export interface CreativeRenderPage {
  on(event: "console", handler: (message: CreativeRenderConsoleMessage) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  on(event: "requestfailed", handler: (request: CreativeRenderRequest) => void): void;
  goto(
    url: string,
    options: { readonly waitUntil: "load"; readonly timeout: number },
  ): Promise<CreativeRenderResponse | null>;
  evaluate(expression: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  hover(selector: string, options: { readonly timeout: number }): Promise<unknown>;
  screenshot(options: {
    readonly type: "png";
    readonly timeout: number;
    readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }): Promise<Uint8Array>;
  close(): Promise<unknown>;
}

export interface CreativeRenderContext {
  addInitScript(script: string): Promise<unknown>;
  route(url: "**/*", handler: (route: CreativeRenderRoute) => Promise<unknown>): Promise<unknown>;
  newPage(): Promise<CreativeRenderPage>;
  close(): Promise<unknown>;
}

export interface CreativeRenderContextOptions {
  readonly viewport: { readonly width: number; readonly height: number; readonly deviceScaleFactor: number };
  readonly reducedMotion: "reduce" | "no-preference";
  readonly serviceWorkers: "block";
}

export interface CreativeRenderBrowser {
  newContext(options: CreativeRenderContextOptions): Promise<CreativeRenderContext>;
  close(): Promise<unknown>;
}

export type LaunchCreativeRenderBrowser = () => Promise<CreativeRenderBrowser>;
export type ReadArtifactHash = (rootDir: string, ignoredDir?: string) => Promise<string> | string;

export interface CreativeRenderFile {
  readonly captureId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface CreativeRenderOutput {
  readonly manifest: RenderManifestV1;
  readonly canonicalJson: string;
  readonly renderManifestHash: string;
  readonly evidenceIndex: TasteEvidenceIndex;
  readonly facts: readonly TastePromptFact[];
  readonly files: readonly CreativeRenderFile[];
}

export type CreativeRenderResult =
  | { readonly ok: true; readonly output: CreativeRenderOutput }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly issues: readonly RenderIssueV1[];
      readonly manifest?: RenderManifestV1;
    };

export interface CreativeRenderOptions {
  readonly preview: ActivePreview;
  readonly binding: RenderManifestBinding;
  readonly iteration: number;
  readonly outputDir: string;
  readonly launch?: LaunchCreativeRenderBrowser;
  readonly navigationTimeoutMs?: number;
  readonly screenshotTimeoutMs?: number;
  readonly now?: () => Date;
  readonly writeFile?: (path: string, bytes: Uint8Array) => void;
  readonly readBackFile?: (path: string) => Uint8Array;
  readonly readArtifactHash?: ReadArtifactHash;
  readonly stateDriver?: CreativeRenderStateDriver;
}

export type CreativeRenderStateDriver = (
  page: CreativeRenderPage,
  route: CreativeRouteV1,
  section: CreativeSectionV1,
  state: RequiredRenderState,
) => Promise<boolean>;

interface RenderIssueDetail {
  readonly code: RenderIssueCode;
  readonly severity: RenderIssueSeverity;
  readonly profileId: RenderProfileId;
  readonly routeId: string;
  readonly sectionId: string | null;
  readonly motionId: string | null;
  readonly evidenceSha256: string;
  readonly detail: string;
}

interface PageIssueCollector {
  readonly console: string[];
  readonly runtime: string[];
  readonly request: string[];
}

interface SectionBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface RawAssetRef {
  readonly kind: string;
  readonly locator: string | null;
  readonly provenance: RenderAssetProvenance;
}

interface SectionSnapshot {
  readonly sectionId: string;
  readonly routeId: string | null;
  readonly box: SectionBox | null;
  readonly texts: readonly string[];
  readonly motionIds: readonly string[];
  readonly stateTokens: readonly string[];
  readonly assets: readonly RawAssetRef[];
}

interface RouteSnapshot {
  readonly pathname: string;
  readonly routeMarkers: readonly string[];
  readonly sectionOrder: readonly string[];
  readonly sections: readonly SectionSnapshot[];
  readonly horizontalOverflow: boolean;
}

interface MotionObservation {
  readonly observedProperties: readonly ("opacity" | "transform")[];
  readonly sampleIndexes: readonly number[];
}

interface MotionRouteBundle {
  readonly traces: readonly RenderMotionTraceV1[];
  readonly issues: readonly RenderIssueDetail[];
}

const PLAYWRIGHT_MODULE: string = "playwright";

const MOTION_PROBE_SOURCE = `
(() => {
  if (window.__creativeRenderProbe !== undefined) return;
  var ATTRIBUTE = ${JSON.stringify(CREATIVE_MOTION_ATTRIBUTE)};
  var sample = 0;
  var records = new Map();

  var scan = function () {
    var nodes = document.querySelectorAll("[" + ATTRIBUTE + "]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var id = el.getAttribute(ATTRIBUTE);
      if (!id || records.has(id)) continue;
      var cs = getComputedStyle(el);
      records.set(id, {
        el: el,
        prevTransform: cs.transform,
        prevOpacity: cs.opacity,
        props: [],
        sampleIndexes: []
      });
    }
  };

  var pushUnique = function (list, value, limit) {
    if (list.indexOf(value) >= 0) return;
    if (list.length < limit) list.push(value);
  };

  var tick = function () {
    sample += 1;
    scan();
    records.forEach(function (record) {
      var cs = getComputedStyle(record.el);
      if (cs.transform !== record.prevTransform) {
        pushUnique(record.props, "transform", 2);
        pushUnique(record.sampleIndexes, sample, 16);
        record.prevTransform = cs.transform;
      }
      if (cs.opacity !== record.prevOpacity) {
        pushUnique(record.props, "opacity", 2);
        pushUnique(record.sampleIndexes, sample, 16);
        record.prevOpacity = cs.opacity;
      }
    });
    requestAnimationFrame(tick);
  };

  window.__creativeRenderProbe = {
    trace: function (id) {
      scan();
      var record = records.get(id);
      if (!record) return { observedProperties: [], sampleIndexes: [] };
      return {
        observedProperties: record.props.slice(),
        sampleIndexes: record.sampleIndexes.slice()
      };
    }
  };

  requestAnimationFrame(tick);
})();
`;

const NO_MEDIA_SOURCE = `
(() => {
  if (window.__creativeRenderNoMedia !== undefined) return;
  window.__creativeRenderNoMedia = true;
  var css = [
    "img,svg,video,picture,canvas,object,embed{",
    "opacity:0!important;visibility:hidden!important;pointer-events:none!important;",
    "}"
  ].join("");
  var install = function () {
    var style = document.createElement("style");
    style.textContent = css;
    var host = document.head || document.documentElement;
    if (host) host.appendChild(style);
  };
  install();
  document.addEventListener("DOMContentLoaded", install, { once: true });
})();
`;

export function playwrightCreativeRenderLaunch(): LaunchCreativeRenderBrowser {
  return async () => {
    let mod: {
      chromium?: { launch(options: { headless: boolean; timeout: number }): Promise<CreativeRenderBrowser> };
    };
    try {
      mod = await import(PLAYWRIGHT_MODULE);
    } catch (error) {
      throw new Error(`playwright could not be loaded (${messageOf(error)})`);
    }
    const chromium = mod.chromium;
    if (chromium === undefined) throw new Error("the resolved playwright module exports no `chromium` launcher");
    return await chromium.launch({ headless: true, timeout: CREATIVE_NAVIGATION_TIMEOUT_MS });
  };
}

export async function captureCreativeRender(options: CreativeRenderOptions): Promise<CreativeRenderResult> {
  const launch = options.launch ?? playwrightCreativeRenderLaunch();
  const writeFile = options.writeFile ?? ((path: string, bytes: Uint8Array) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  });
  const readBackFile = options.readBackFile ?? ((path: string) => readFileSync(path));
  const readArtifactHash = options.readArtifactHash ?? hashDirectoryTree;
  const navigationTimeout = options.navigationTimeoutMs ?? CREATIVE_NAVIGATION_TIMEOUT_MS;
  const screenshotTimeout = options.screenshotTimeoutMs ?? CREATIVE_SCREENSHOT_TIMEOUT_MS;

  const bindingError = verifyBinding(options.binding);
  if (bindingError !== null) return { ok: false, reason: bindingError, issues: [] };

  const ignoredDir = isWithin(options.preview.rootDir, options.outputDir) ? options.outputDir : undefined;
  const beforeHash = await Promise.resolve(readArtifactHash(options.preview.rootDir, ignoredDir));
  if (beforeHash !== options.binding.artifactHash) {
    return { ok: false, reason: "preview artefact hash is stale before rendered capture starts", issues: [] };
  }

  const plannedCaptures = totalCaptureCount(options.binding.contract);
  if (plannedCaptures > 2_000) {
    return { ok: false, reason: `render capture would exceed 2000 frames (${String(plannedCaptures)})`, issues: [] };
  }

  const files: CreativeRenderFile[] = [];
  const captures: RenderCaptureV1[] = [];
  const traces: RenderMotionTraceV1[] = [];
  const issues: RenderIssueDetail[] = [];
  let totalBytes = 0;

  let browser: CreativeRenderBrowser;
  try {
    browser = await launch();
  } catch (error) {
    return {
      ok: false,
      reason: `the browser could not be started: ${messageOf(error)}`,
      issues: [],
    };
  }

  try {
    for (const profileId of RENDER_PROFILE_IDS) {
      const profile = REQUIRED_RENDER_PROFILES[profileId];
      const result = await captureProfile({
        browser,
        preview: options.preview,
        binding: options.binding,
        profile,
        outputDir: options.outputDir,
        writeFile,
        readBackFile,
        navigationTimeout,
        screenshotTimeout,
        ...(options.stateDriver === undefined ? {} : { stateDriver: options.stateDriver }),
      });
      captures.push(...result.captures);
      traces.push(...result.motion.traces);
      issues.push(...result.issues, ...result.motion.issues);
      files.push(...result.files);
      totalBytes += result.files.reduce((sum, file) => sum + file.bytes, 0);
      if (issues.some(isFatalIssue)) break;
      if (totalBytes > MAX_CREATIVE_TOTAL_BYTES) {
        issues.push(
          issue(
            "CAPTURE_FAILED",
            "blocking",
            profile.id,
            options.binding.contract.routes[0]?.id ?? "unknown",
            null,
            null,
            `captured screenshot bytes exceeded ${String(MAX_CREATIVE_TOTAL_BYTES)}`,
          ),
        );
        break;
      }
    }
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore browser close failures */
    }
  }

  const manifest: RenderManifestV1 = {
    schemaVersion: 1,
    contractHash: options.binding.contractHash,
    artifactHash: options.binding.artifactHash,
    iteration: options.iteration,
    profiles: RENDER_PROFILE_IDS.map((id) => REQUIRED_RENDER_PROFILES[id]),
    captures,
    motionTraces: traces,
    issues: issues.map(stripIssueDetail),
  };

  const afterHash = await Promise.resolve(readArtifactHash(options.preview.rootDir, ignoredDir));
  if (afterHash !== options.binding.artifactHash) {
    return {
      ok: false,
      reason: "preview artefact hash changed during rendered capture",
      issues: manifest.issues,
      manifest,
    };
  }

  if (issues.some(isFatalIssue)) {
    return {
      ok: false,
      reason: issues.find(isFatalIssue)?.detail ?? "rendered capture failed",
      issues: manifest.issues,
      manifest,
    };
  }

  const validated = validateRenderManifest(JSON.stringify(manifest), options.binding);
  if (!validated.ok) {
    return {
      ok: false,
      reason: `${validated.errors[0]?.code ?? "INVALID_RENDER_MANIFEST"} at ${validated.errors[0]?.path ?? "/"}`,
      issues: manifest.issues,
      manifest,
    };
  }

  const evidenceIndex = buildTasteEvidenceIndex(options.binding.contract, validated.manifest, validated.renderManifestHash);
  const facts = buildTastePromptFacts(options.binding.contract, validated.manifest, validated.renderManifestHash);
  return {
    ok: true,
    output: {
      manifest: validated.manifest,
      canonicalJson: validated.canonicalJson,
      renderManifestHash: validated.renderManifestHash,
      evidenceIndex,
      facts,
      files,
    },
  };
}

export function buildCreativeTastePromptInput(output: CreativeRenderOutput, contract: CreativeContractV1): TasteCriticPromptInput {
  return {
    evidenceIndex: output.evidenceIndex,
    facts: output.facts,
    intentionalExceptions: contract.intentionalExceptions.map((item) => ({
      rule: item.rule,
      sectionIds: item.sectionIds,
      rationale: item.rationale,
    })),
  };
}

export function buildTasteEvidenceIndex(
  contract: CreativeContractV1,
  manifest: RenderManifestV1,
  renderManifestHash: string,
): TasteEvidenceIndex {
  const routes = contract.routes.map((route) => ({ id: route.id, sectionIds: [...route.sectionIds] }));
  const frames = manifest.profiles.flatMap((profile) => contract.routes.map((route) => ({
    id: frameId(profile.id, route.id),
    routeId: route.id,
    sectionIds: [...route.sectionIds],
    motionIds: contract.motion.filter((item) => item.routeId === route.id).map((item) => item.id),
  })));

  const evidence: TasteEvidence[] = [];
  for (const capture of manifest.captures.filter((item) => item.state === "default")) {
    const currentFrameId = frameId(capture.profileId, capture.routeId);
    for (const text of capture.domText) {
      evidence.push({
        kind: "dom_text",
        frameId: currentFrameId,
        sectionId: capture.sectionId,
        excerpt: text.excerpt,
        textSha256: text.textSha256,
      });
    }
    for (const region of capture.regions) {
      evidence.push({
        kind: "region",
        frameId: currentFrameId,
        sectionId: capture.sectionId,
        screenshotSha256: capture.screenshotSha256,
        box: { ...region.box },
      });
    }
    for (const asset of capture.assets) {
      evidence.push({
        kind: "asset",
        frameId: currentFrameId,
        sectionId: capture.sectionId,
        contentSha256: asset.contentSha256,
        provenance: asset.provenance,
      });
    }
  }
  for (const trace of manifest.motionTraces) {
    evidence.push({
      kind: "motion_trace",
      frameId: frameId(trace.profileId, trace.routeId),
      motionId: trace.motionId,
      sampleIndexes: [...trace.sampleIndexes],
      observedProperties: [...trace.observedProperties],
    });
  }

  return {
    contractHash: manifest.contractHash,
    renderManifestHash,
    routes,
    frames,
    contractPointers: contractPointersOf(contract).map((item) => item.pointer),
    evidence,
  };
}

export function buildTastePromptFacts(
  contract: CreativeContractV1,
  manifest: RenderManifestV1,
  renderManifestHash: string,
): readonly TastePromptFact[] {
  const facts: TastePromptFact[] = [];
  const pointers = contractPointersOf(contract);
  for (const [index, pointer] of pointers.entries()) {
    facts.push({
      id: `contract-${String(index)}`,
      evidence: { kind: "contract", pointer: pointer.pointer, valueSha256: pointer.valueSha256 },
      observation: boundedObservation(pointer.observation),
    });
  }

  for (const capture of manifest.captures.filter((item) => item.state === "default")) {
    const currentFrameId = frameId(capture.profileId, capture.routeId);
    for (const [index, text] of capture.domText.entries()) {
      facts.push({
        id: `dom-${capture.id}-${String(index)}`,
        evidence: {
          kind: "dom_text",
          frameId: currentFrameId,
          sectionId: capture.sectionId,
          excerpt: text.excerpt,
          textSha256: text.textSha256,
        },
        observation: boundedObservation(
          `${capture.profileId} ${capture.routeId}/${capture.sectionId} text: ${text.excerpt}`,
        ),
      });
    }
    for (const [index, region] of capture.regions.entries()) {
      facts.push({
        id: `region-${capture.id}-${String(index)}`,
        evidence: {
          kind: "region",
          frameId: currentFrameId,
          sectionId: capture.sectionId,
          screenshotSha256: capture.screenshotSha256,
          box: { ...region.box },
        },
        observation: boundedObservation(
          `${capture.profileId} ${capture.routeId}/${capture.sectionId} region ${region.id} is ${String(Math.round(region.box.width))}x${String(Math.round(region.box.height))} at ${String(Math.round(region.box.x))},${String(Math.round(region.box.y))}.`,
        ),
      });
    }
    for (const [index, asset] of capture.assets.entries()) {
      facts.push({
        id: `asset-${capture.id}-${String(index)}`,
        evidence: {
          kind: "asset",
          frameId: currentFrameId,
          sectionId: capture.sectionId,
          contentSha256: asset.contentSha256,
          provenance: asset.provenance,
        },
        observation: boundedObservation(
          `${capture.profileId} ${capture.routeId}/${capture.sectionId} asset provenance is ${asset.provenance}.`,
        ),
      });
    }
  }

  for (const trace of manifest.motionTraces) {
    facts.push({
      id: `motion-${trace.id}`,
      evidence: {
        kind: "motion_trace",
        frameId: frameId(trace.profileId, trace.routeId),
        motionId: trace.motionId,
        sampleIndexes: [...trace.sampleIndexes],
        observedProperties: [...trace.observedProperties],
      },
      observation: boundedObservation(
        `${trace.profileId} motion ${trace.motionId} on ${trace.routeId}/${trace.sectionId} observed ${trace.observedProperties.join(", ") || "nothing"} at samples ${trace.sampleIndexes.join(", ")}.`,
      ),
    });
  }

  if (facts.length > MAX_CREATIVE_FACTS) return facts.slice(0, MAX_CREATIVE_FACTS);
  void renderManifestHash;
  return facts;
}

async function captureProfile(options: {
  readonly browser: CreativeRenderBrowser;
  readonly preview: ActivePreview;
  readonly binding: RenderManifestBinding;
  readonly profile: RenderProfileV1;
  readonly outputDir: string;
  readonly writeFile: (path: string, bytes: Uint8Array) => void;
  readonly readBackFile: (path: string) => Uint8Array;
  readonly navigationTimeout: number;
  readonly screenshotTimeout: number;
  readonly stateDriver?: CreativeRenderStateDriver;
}): Promise<{
  readonly captures: readonly RenderCaptureV1[];
  readonly motion: MotionRouteBundle;
  readonly files: readonly CreativeRenderFile[];
  readonly issues: readonly RenderIssueDetail[];
}> {
  const issues: RenderIssueDetail[] = [];
  const captures: RenderCaptureV1[] = [];
  const traces: RenderMotionTraceV1[] = [];
  const files: CreativeRenderFile[] = [];
  const sections = new Map(options.binding.contract.sections.map((item) => [item.id, item]));
  const motionsByRoute = new Map<string, CreativeMotionV1[]>();
  for (const motion of options.binding.contract.motion) {
    const list = motionsByRoute.get(motion.routeId) ?? [];
    list.push(motion);
    motionsByRoute.set(motion.routeId, list);
  }

  const context = await options.browser.newContext({
    viewport: options.profile.viewport,
    reducedMotion: options.profile.reducedMotion === "reduce" ? "reduce" : "no-preference",
    serviceWorkers: "block",
  });
  try {
    const blockedRequests: string[] = [];
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (creativeRenderRequestAllowed(options.preview.url, requestUrl)) {
        await route.continue();
        return;
      }
      if (blockedRequests.length < MAX_CREATIVE_EVENTS_PER_KIND) blockedRequests.push(requestUrl);
      await route.abort("blockedbyclient");
    });
    await context.addInitScript(MOTION_PROBE_SOURCE);
    if (options.profile.media === "disabled") await context.addInitScript(NO_MEDIA_SOURCE);

    for (const route of options.binding.contract.routes) {
      const page = await context.newPage();
      const pageEvents = collectPageIssues(page);
      try {
        const response = await page.goto(new URL(route.path, `${options.preview.url}/`).toString(), {
          waitUntil: "load",
          timeout: options.navigationTimeout,
        });
        await page.waitForTimeout(CREATIVE_STATE_SETTLE_MS);

        for (const blocked of blockedRequests.splice(0)) {
          issues.push(
            issue(
              "BROKEN_NAVIGATION",
              "blocking",
              options.profile.id,
              route.id,
              null,
              null,
              `render capture blocked network egress to ${blocked}`,
            ),
          );
        }
        if (issues.some(isFatalIssue)) break;

        if ((response?.status() ?? 200) >= 400) {
          issues.push(
            issue(
              "BROKEN_NAVIGATION",
              "blocking",
              options.profile.id,
              route.id,
              null,
              null,
              `navigation to ${route.path} returned HTTP ${String(response?.status() ?? 0)}`,
            ),
          );
          break;
        }

        const snapshot = await readRouteSnapshot(page, route.id);
        validateRouteSnapshot(snapshot, route, options.profile.id, issues);
        if (pageEvents.console.length > 0 || pageEvents.runtime.length > 0 || pageEvents.request.length > 0) {
          issues.push(...eventIssues(pageEvents, options.profile.id, route.id));
        }
        if (issues.some(isFatalIssue)) break;

        for (const sectionId of route.sectionIds) {
          const section = sections.get(sectionId);
          if (section === undefined) continue;
          for (const state of section.requiredStates) {
            const prepared = await driveState(
              page,
              route,
              section,
              state,
              options.stateDriver,
            );
            if (!prepared) {
              issues.push(
                issue(
                  "CAPTURE_FAILED",
                  "blocking",
                  options.profile.id,
                  route.id,
                  section.id,
                  null,
                  `section ${section.id} could not be prepared for state ${state}`,
                ),
              );
              break;
            }
            await page.waitForTimeout(state === "interaction" ? CREATIVE_INTERACTION_SETTLE_MS : CREATIVE_STATE_SETTLE_MS);
            const refreshed = await readRouteSnapshot(page, route.id);
            const snap = refreshed.sections.find((item) => item.sectionId === section.id);
            if (snap === undefined || snap.box === null || snap.routeId !== route.id) {
              issues.push(
                issue(
                  "SECTION_NOT_FOUND",
                  "blocking",
                  options.profile.id,
                  route.id,
                  section.id,
                  null,
                  `section marker ${section.id} was missing or unreadable for state ${state}`,
                ),
              );
              break;
            }
            if (state !== "default" && !stateIsRepresented(snap, state)) {
              issues.push(
                issue(
                  "CAPTURE_FAILED",
                  "blocking",
                  options.profile.id,
                  route.id,
                  section.id,
                  null,
                  `section ${section.id} does not expose a ${state} state marker`,
                ),
              );
              break;
            }
            const capture = await screenshotCapture({
              page,
              route,
              section,
              state,
              profileId: options.profile.id,
              outputDir: options.outputDir,
              snapshot: snap,
              screenshotTimeout: options.screenshotTimeout,
              writeFile: options.writeFile,
              readBackFile: options.readBackFile,
            });
            captures.push(capture.capture);
            files.push(capture.file);
            if (refreshed.horizontalOverflow) {
              issues.push(
                issue(
                  "HORIZONTAL_OVERFLOW",
                  "warning",
                  options.profile.id,
                  route.id,
                  section.id,
                  null,
                  capture.capture.screenshotSha256,
                ),
              );
            }
          }
          if (issues.some(isFatalIssue)) break;
        }
        if (issues.some(isFatalIssue)) break;

        const motion = await buildMotionTraces(
          page,
          route,
          motionsByRoute.get(route.id) ?? [],
          options.profile,
          captures,
        );
        traces.push(...motion.traces);
        issues.push(...motion.issues);
        if (issues.some(isFatalIssue)) break;
      } catch (error) {
        issues.push(
          issue(
            "CAPTURE_FAILED",
            "blocking",
            options.profile.id,
            route.id,
            null,
            null,
            `render capture failed for ${route.path}: ${messageOf(error)}`,
          ),
        );
        break;
      } finally {
        try {
          await page.close();
        } catch {
          /* ignore page close failures */
        }
      }
    }
  } finally {
    try {
      await context.close();
    } catch {
      /* ignore context close failures */
    }
  }

  return { captures, motion: { traces, issues }, files, issues };
}

export function creativeRenderRequestAllowed(previewUrl: string, requestUrl: string): boolean {
  if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) return true;
  try {
    return new URL(requestUrl).origin === new URL(previewUrl).origin;
  } catch {
    return false;
  }
}

async function screenshotCapture(options: {
  readonly page: CreativeRenderPage;
  readonly route: CreativeRouteV1;
  readonly section: CreativeSectionV1;
  readonly state: RequiredRenderState;
  readonly profileId: RenderProfileId;
  readonly outputDir: string;
  readonly snapshot: SectionSnapshot;
  readonly screenshotTimeout: number;
  readonly writeFile: (path: string, bytes: Uint8Array) => void;
  readonly readBackFile: (path: string) => Uint8Array;
}): Promise<{ readonly capture: RenderCaptureV1; readonly file: CreativeRenderFile }> {
  const box = clippedBox(options.snapshot.box);
  const relativePath = `captures/${options.profileId}/${options.route.id}/${options.section.id}-${options.state}.png`;
  const absolutePath = join(options.outputDir, relativePath);
  const bytes = await options.page.screenshot({
    type: "png",
    timeout: options.screenshotTimeout,
    clip: box,
  });
  options.writeFile(absolutePath, bytes);
  const sha256 = digestOf(bytes);
  const readBack = options.readBackFile(absolutePath);
  if (digestOf(readBack) !== sha256 || readBack.byteLength !== bytes.byteLength) {
    throw new Error(`screenshot file digest mismatch for ${relativePath}`);
  }

  const captureId = `${options.profileId}:${options.section.id}:${options.state}`;
  const capture: RenderCaptureV1 = {
    id: captureId,
    profileId: options.profileId,
    routeId: options.route.id,
    sectionId: options.section.id,
    state: options.state,
    urlPath: options.route.path,
    screenshotPath: relativePath,
    screenshotSha256: sha256,
    domText: domTextOf(options.snapshot.texts),
    regions: [{ id: "section", box }],
    assets: assetsOf(options.snapshot.assets),
  };
  return {
    capture,
    file: { captureId, relativePath, sha256, bytes: bytes.byteLength },
  };
}

async function buildMotionTraces(
  page: CreativeRenderPage,
  route: CreativeRouteV1,
  motions: readonly CreativeMotionV1[],
  profile: RenderProfileV1,
  captures: readonly RenderCaptureV1[],
): Promise<MotionRouteBundle> {
  const traces: RenderMotionTraceV1[] = [];
  const issues: RenderIssueDetail[] = [];
  for (const motion of motions) {
    const observation = await readMotionObservation(page, motion.id);
    const activeProfile = profile.reducedMotion === "no_preference" && profile.media === "enabled";
    if (profile.reducedMotion === "reduce" && observation.observedProperties.length > 0) {
      issues.push(
        issue(
          "REDUCED_MOTION_ACTIVE",
          "blocking",
          profile.id,
          route.id,
          motion.sectionId,
          motion.id,
          `motion ${motion.id} remained active under reduced motion`,
        ),
      );
      continue;
    }
    if (activeProfile && observation.observedProperties.length === 0) {
      issues.push(
        issue(
          "MOTION_NOT_OBSERVED",
          "blocking",
          profile.id,
          route.id,
          motion.sectionId,
          motion.id,
          `motion ${motion.id} was not observed on an active render profile`,
        ),
      );
      continue;
    }
    const capture = captures.find(
      (item) =>
        item.profileId === profile.id &&
        item.routeId === route.id &&
        item.sectionId === motion.sectionId &&
        item.state === (motion.trigger === "interaction" ? "interaction" : "default"),
    );
    if (capture === undefined) {
      issues.push(
        issue(
          "MOTION_NOT_OBSERVED",
          "blocking",
          profile.id,
          route.id,
          motion.sectionId,
          motion.id,
          `motion ${motion.id} has no matching capture for its route and section`,
        ),
      );
      continue;
    }
    traces.push({
      id: `${profile.id}:${motion.id}`,
      motionId: motion.id,
      captureId: capture.id,
      profileId: profile.id,
      routeId: route.id,
      sectionId: motion.sectionId,
      sampleIndexes: observation.sampleIndexes.length > 0 ? [...observation.sampleIndexes] : [0],
      observedProperties: [...observation.observedProperties],
      fallbackState: fallbackStateFor(profile, motion),
    });
  }
  return { traces, issues };
}

function collectPageIssues(page: CreativeRenderPage): PageIssueCollector {
  const events: PageIssueCollector = { console: [], runtime: [], request: [] };
  page.on("console", (message) => {
    if (events.console.length >= MAX_CREATIVE_EVENTS_PER_KIND) return;
    const type = message.type();
    if (type === "error" || type === "warning") events.console.push(`${type}: ${message.text().trim()}`);
  });
  page.on("pageerror", (error) => {
    if (events.runtime.length >= MAX_CREATIVE_EVENTS_PER_KIND) return;
    events.runtime.push(error.message.trim());
  });
  page.on("requestfailed", (request) => {
    if (events.request.length >= MAX_CREATIVE_EVENTS_PER_KIND) return;
    const failure = request.failure();
    events.request.push(`${request.resourceType()} ${request.url()} ${failure?.errorText ?? "request failed"}`.trim());
  });
  return events;
}

function eventIssues(
  events: PageIssueCollector,
  profileId: RenderProfileId,
  routeId: string,
): readonly RenderIssueDetail[] {
  const issues: RenderIssueDetail[] = [];
  for (const item of events.console) issues.push(issue("CONSOLE_ERROR", "blocking", profileId, routeId, null, null, item));
  for (const item of events.runtime) issues.push(issue("PAGE_ERROR", "blocking", profileId, routeId, null, null, item));
  for (const item of events.request) issues.push(issue("BROKEN_NAVIGATION", "blocking", profileId, routeId, null, null, item));
  return issues;
}

function validateRouteSnapshot(
  snapshot: RouteSnapshot,
  route: CreativeRouteV1,
  profileId: RenderProfileId,
  issues: RenderIssueDetail[],
): void {
  if (snapshot.pathname !== route.path) {
    issues.push(issue("BROKEN_NAVIGATION", "blocking", profileId, route.id, null, null, `route loaded ${snapshot.pathname} instead of ${route.path}`));
  }
  if (snapshot.routeMarkers.length === 1 && snapshot.routeMarkers[0] !== route.id) {
    issues.push(issue("SECTION_NOT_FOUND", "blocking", profileId, route.id, null, null, `route marker mismatch: expected ${route.id}, found ${snapshot.routeMarkers[0] ?? "unknown"}`));
  } else if (snapshot.routeMarkers.length !== 1) {
    const state = snapshot.routeMarkers.length === 0 ? "missing" : `duplicated (${String(snapshot.routeMarkers.length)} markers)`;
    issues.push(issue("SECTION_NOT_FOUND", "blocking", profileId, route.id, null, null, `route marker for ${route.id} is ${state}`));
  }
  const routeSections = snapshot.sections.filter((item) => item.routeId === route.id);
  for (const [index, sectionId] of route.sectionIds.entries()) {
    const matches = snapshot.sections.filter((item) => item.sectionId === sectionId && item.routeId === route.id);
    if (matches.length !== 1) {
      const observed = routeSections[index]?.sectionId;
      const oneForSlot = matches.length === 0 && routeSections.length === route.sectionIds.length && observed !== undefined;
      const detail = oneForSlot
        ? `section marker mismatch on ${route.id} at position ${String(index + 1)}: expected ${sectionId}, found ${observed}`
        : matches.length === 0
          ? `section marker ${sectionId} is missing on ${route.id}`
          : `section marker ${sectionId} is duplicated (${String(matches.length)} matches) on ${route.id}`;
      issues.push(issue("SECTION_NOT_FOUND", "blocking", profileId, route.id, sectionId, null, detail));
    }
  }
}

/** Deterministic render-contract failures are not critic infrastructure outages. */
export function creativeRenderRefusalClass(result: CreativeRenderResult): "artifact_contract" | "critic_unavailable" {
  if (result.ok) return "critic_unavailable";
  const deterministicIssue = result.issues.some((issue) => issue.code !== "CAPTURE_FAILED");
  const deterministicReason = /^(?:binding |preview artefact |render capture would exceed|section |captured screenshot bytes)/u.test(result.reason);
  return deterministicIssue || deterministicReason ? "artifact_contract" : "critic_unavailable";
}

async function driveState(
  page: CreativeRenderPage,
  route: CreativeRouteV1,
  section: CreativeSectionV1,
  state: RequiredRenderState,
  driver?: CreativeRenderStateDriver,
): Promise<boolean> {
  if (driver !== undefined) return await driver(page, route, section, state);
  await page.evaluate(scrollSectionExpression(section.id));
  if (state === "default") return true;
  if (state === "interaction") {
    try {
      await page.hover(attributeSelector(CREATIVE_SECTION_ATTRIBUTE, section.id), { timeout: CREATIVE_HOVER_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
  return await page.evaluate(hasStateMarkerExpression(section.id, state)) === true;
}

async function readRouteSnapshot(page: CreativeRenderPage, routeId: string): Promise<RouteSnapshot> {
  const raw = await page.evaluate(routeSnapshotExpression(routeId));
  if (!isRecordObject(raw)) return { pathname: "", routeMarkers: [], sectionOrder: [], sections: [], horizontalOverflow: false };

  const sections: SectionSnapshot[] = [];
  const rawSections = raw["sections"];
  if (Array.isArray(rawSections)) {
    for (const item of rawSections) {
      if (!isRecordObject(item)) continue;
      const sectionId = stringField(item, "sectionId");
      if (sectionId === null) continue;
      sections.push({
        sectionId,
        routeId: nullableStringField(item, "routeId"),
        box: boxField(item["box"]),
        texts: stringArray(item["texts"]),
        motionIds: stringArray(item["motionIds"]),
        stateTokens: stringArray(item["stateTokens"]),
        assets: assetArray(item["assets"]),
      });
    }
  }
  return {
    pathname: nullableStringField(raw, "pathname") ?? "",
    routeMarkers: stringArray(raw["routeMarkers"]),
    sectionOrder: stringArray(raw["sectionOrder"]),
    sections,
    horizontalOverflow: raw["horizontalOverflow"] === true,
  };
}

async function readMotionObservation(page: CreativeRenderPage, motionId: string): Promise<MotionObservation> {
  const raw = await page.evaluate(`window.__creativeRenderProbe.trace(${JSON.stringify(motionId)})`);
  if (!isRecordObject(raw)) return { observedProperties: [], sampleIndexes: [] };
  const properties = stringArray(raw["observedProperties"]).filter(
    (item): item is "opacity" | "transform" => item === "opacity" || item === "transform",
  );
  const sampleIndexes = numberArray(raw["sampleIndexes"]);
  return { observedProperties: properties, sampleIndexes };
}

function routeSnapshotExpression(routeId: string): string {
  return `(() => {
    const routeAttr = ${JSON.stringify(CREATIVE_ROUTE_ATTRIBUTE)};
    const sectionAttr = ${JSON.stringify(CREATIVE_SECTION_ATTRIBUTE)};
    const motionAttr = ${JSON.stringify(CREATIVE_MOTION_ATTRIBUTE)};
    const routeEls = Array.from(document.querySelectorAll("[" + routeAttr + "]"));
    const routeMarkers = routeEls.map((el) => el.getAttribute(routeAttr)).filter((value) => typeof value === "string");
    const routeEl = routeEls.find((el) => el.getAttribute(routeAttr) === ${JSON.stringify(routeId)}) ?? null;
    const scope = routeEl ?? document.body;
    const clamp = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 240);
    const boxOf = (el) => {
      if (!(el instanceof Element)) return null;
      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: Math.max(0, rect.left + window.scrollX),
        y: Math.max(0, rect.top + window.scrollY),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height)
      };
    };
    const textNodes = (el) => {
      const out = [];
      const seen = new Set();
      const nodes = el.querySelectorAll("h1,h2,h3,h4,p,li,a,button,span,strong,em");
      for (let i = 0; i < nodes.length; i++) {
        const text = clamp(nodes[i].textContent);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
        if (out.length >= ${String(MAX_CREATIVE_TEXT_PER_CAPTURE)}) break;
      }
      return out;
    };
    const assets = (el) => {
      const out = [];
      const nodes = el.querySelectorAll("img,svg,video,picture source,source,canvas,object,embed");
      for (let i = 0; i < nodes.length && out.length < ${String(MAX_CREATIVE_ASSETS_PER_CAPTURE)}; i++) {
        const node = nodes[i];
        const tag = node.tagName.toLowerCase();
        let locator = null;
        let provenance = "unknown";
        if (tag === "img" || tag === "video" || tag === "source") {
          locator = node.currentSrc || node.getAttribute("src") || node.getAttribute("srcset") || node.getAttribute("poster");
          if (!locator) provenance = "missing";
          else if (/^(?:https?:)?\\/\\//i.test(locator) && !(locator.indexOf(window.location.origin) === 0)) provenance = "forbidden_remote";
          else provenance = "matched";
        } else if (tag === "svg" || tag === "canvas") {
          locator = "inline:" + tag + ":" + String(i);
          provenance = "unknown";
        } else {
          locator = node.getAttribute("data") || node.getAttribute("src");
          provenance = locator ? "matched" : "missing";
        }
        out.push({ kind: tag, locator, provenance });
      }
      return out;
    };
    const sectionEls = scope ? Array.from(scope.querySelectorAll("[" + sectionAttr + "]")) : [];
    return {
      pathname: window.location.pathname,
      routeMarkers,
      sectionOrder: sectionEls.map((el) => el.getAttribute(sectionAttr)).filter((value) => typeof value === "string"),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      sections: sectionEls.map((el) => ({
        sectionId: el.getAttribute(sectionAttr),
        routeId: el.closest("[" + routeAttr + "]")?.getAttribute(routeAttr) ?? null,
        box: boxOf(el),
        texts: textNodes(el),
        motionIds: Array.from(el.querySelectorAll("[" + motionAttr + "]")).map((node) => node.getAttribute(motionAttr)).filter((value) => typeof value === "string"),
        stateTokens: [el.getAttribute("data-state"), ...Array.from(el.querySelectorAll("[data-state]")).map((node) => node.getAttribute("data-state"))].filter((value) => typeof value === "string"),
        assets: assets(el),
      })),
    };
  })()`;
}

function scrollSectionExpression(sectionId: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(attributeSelector(CREATIVE_SECTION_ATTRIBUTE, sectionId))});
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  })()`;
}

function hasStateMarkerExpression(sectionId: string, state: RequiredRenderState): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(attributeSelector(CREATIVE_SECTION_ATTRIBUTE, sectionId))});
    if (!el) return false;
    if (el.getAttribute("data-state") === ${JSON.stringify(state)}) return true;
    return el.querySelector('[data-state=${JSON.stringify(state).replace(/^"|"$/g, "'")}]') !== null;
  })()`;
}

function stateIsRepresented(snapshot: SectionSnapshot, state: RequiredRenderState): boolean {
  if (state === "default" || state === "interaction") return true;
  return snapshot.stateTokens.includes(state);
}

function domTextOf(texts: readonly string[]): readonly { readonly excerpt: string; readonly textSha256: string }[] {
  const unique = new Set<string>();
  const output: { excerpt: string; textSha256: string }[] = [];
  for (const text of texts) {
    const excerpt = boundedObservation(text);
    if (excerpt.length === 0 || unique.has(excerpt)) continue;
    unique.add(excerpt);
    output.push({ excerpt, textSha256: sha256Hex(excerpt) });
  }
  return output;
}

function assetsOf(assets: readonly RawAssetRef[]): readonly RenderAssetV1[] {
  const output: RenderAssetV1[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    const digest = asset.locator === null ? null : sha256Hex(asset.locator);
    const key = `${asset.provenance}:${digest ?? "null"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ contentSha256: digest, provenance: asset.provenance });
  }
  return output;
}

function contractPointersOf(contract: CreativeContractV1): readonly {
  readonly pointer: string;
  readonly valueSha256: string;
  readonly observation: string;
}[] {
  const pointers: { pointer: string; valueSha256: string; observation: string }[] = [];
  for (const section of contract.sections) {
    pointers.push(pointer(`/sections/${section.id}/job`, section.job, `Contract section ${section.id} job: ${section.job}`));
    pointers.push(
      pointer(
        `/sections/${section.id}/layoutFamily`,
        section.layoutFamily,
        `Contract section ${section.id} layout family is ${section.layoutFamily}.`,
      ),
    );
  }
  for (const motion of contract.motion) {
    pointers.push(
      pointer(
        `/motion/${motion.id}/rationale`,
        motion.rationale,
        `Contract motion ${motion.id} rationale: ${motion.rationale}`,
      ),
    );
  }
  for (const proof of contract.contentProof) {
    pointers.push(
      pointer(`/contentProof/${proof.id}`, proof.claim, `Content proof ${proof.id}: ${proof.claim}`),
    );
  }
  return pointers;
}

function pointer(path: string, value: unknown, observation: string): {
  readonly pointer: string;
  readonly valueSha256: string;
  readonly observation: string;
} {
  return {
    pointer: path,
    valueSha256: sha256Hex(canonicalJson(value)),
    observation,
  };
}

function fallbackStateFor(profile: RenderProfileV1, motion: CreativeMotionV1): MotionFallbackState {
  if (profile.reducedMotion === "reduce") return motion.fallback.reducedMotion;
  if (profile.media === "disabled") return motion.fallback.noMedia;
  return "not_applicable";
}

function verifyBinding(binding: RenderManifestBinding): string | null {
  if (sha256Hex(canonicalJson(binding.contract)) !== binding.contractHash) {
    return "binding contract hash does not match the canonical creative contract";
  }
  if (!/^[a-f0-9]{64}$/u.test(binding.artifactHash)) return "binding artefact hash is not a lowercase SHA-256 digest";
  return null;
}

function totalCaptureCount(contract: CreativeContractV1): number {
  return contract.sections.reduce(
    (sum, section) => sum + section.requiredStates.length * RENDER_PROFILE_IDS.length,
    0,
  );
}

function hashDirectoryTree(rootDir: string, ignoredDir?: string): string {
  const root = resolve(rootDir);
  const ignored = ignoredDir === undefined ? null : resolve(ignoredDir);
  const lines: string[] = [];
  walk(root, root, ignored, lines);
  return sha256Hex(lines.join("\n"));
}

function walk(root: string, current: string, ignored: string | null, lines: string[]): void {
  if (ignored !== null && current === ignored) return;
  const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (ignored !== null && full === ignored) continue;
    const rel = relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      lines.push(`D ${rel}`);
      walk(root, full, ignored, lines);
    } else if (entry.isFile()) {
      const bytes = readFileSync(full);
      lines.push(`F ${rel} ${String(bytes.byteLength)} ${digestOf(bytes)}`);
    }
  }
}

function stripIssueDetail(issue: RenderIssueDetail): RenderIssueV1 {
  return {
    code: issue.code,
    severity: issue.severity,
    profileId: issue.profileId,
    routeId: issue.routeId,
    sectionId: issue.sectionId,
    motionId: issue.motionId,
    evidenceSha256: issue.evidenceSha256,
  };
}

function issue(
  code: RenderIssueCode,
  severity: RenderIssueSeverity,
  profileId: RenderProfileId,
  routeId: string,
  sectionId: string | null,
  motionId: string | null,
  detailOrDigest: string,
): RenderIssueDetail {
  const evidenceSha256 = /^[a-f0-9]{64}$/u.test(detailOrDigest) ? detailOrDigest : sha256Hex(detailOrDigest);
  return { code, severity, profileId, routeId, sectionId, motionId, evidenceSha256, detail: detailOrDigest };
}

function isFatalIssue(issue: RenderIssueDetail): boolean {
  return issue.severity === "blocking";
}

function frameId(profileId: RenderProfileId, routeId: string): string {
  return `${profileId}:${routeId}`;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedObservation(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 240);
}

function clippedBox(box: SectionBox | null): SectionBox {
  if (box === null) throw new Error("section box is missing");
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  return {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width,
    height,
  };
}

function attributeSelector(attribute: string, value: string): string {
  return `[${attribute}="${value.replace(/"/gu, '\\"')}"]`;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length === 0 || (!rel.startsWith("..") && !rel.startsWith("../") && rel !== "..");
}

function boxField(value: unknown): SectionBox | null {
  if (!isRecordObject(value)) return null;
  const x = numericField(value, "x");
  const y = numericField(value, "y");
  const width = numericField(value, "width");
  const height = numericField(value, "height");
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function assetArray(value: unknown): readonly RawAssetRef[] {
  if (!Array.isArray(value)) return [];
  const output: RawAssetRef[] = [];
  for (const item of value) {
    if (!isRecordObject(item)) continue;
    const kind = stringField(item, "kind");
    const provenance = stringField(item, "provenance");
    if (kind === null || provenance === null) continue;
    if (
      provenance !== "matched" &&
      provenance !== "unknown" &&
      provenance !== "forbidden_remote" &&
      provenance !== "missing"
    ) continue;
    output.push({ kind, locator: nullableStringField(item, "locator"), provenance });
  }
  return output;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberArray(value: unknown): readonly number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)
    : [];
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" ? item : null;
}

function nullableStringField(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" ? item : null;
}

function numericField(value: Record<string, unknown>, key: string): number | null {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
