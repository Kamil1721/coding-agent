import { mkdtempSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { compileCreativeContract } from "./creative-contract.js";
import type { CreativeContractV1, CreativeEvidenceRef, CreativeSectionV1 } from "./creative-contract.js";
import {
  buildCreativeTastePromptInput,
  buildTasteEvidenceIndex,
  buildTastePromptFacts,
  captureCreativeRender,
  creativeRenderRefusalClass,
  creativeRenderRequestAllowed,
} from "./creative-render.js";
import type {
  CreativeRenderBrowser,
  CreativeRenderConsoleMessage,
  CreativeRenderContext,
  CreativeRenderPage,
  CreativeRenderRequest,
  CreativeRenderRoute,
  LaunchCreativeRenderBrowser,
} from "./creative-render.js";
import { REQUIRED_RENDER_PROFILES } from "./render-manifest.js";
import type { RenderCaptureV1, RenderManifestBinding, RenderManifestV1, RenderProfileId } from "./render-manifest.js";
import { buildTasteCriticPrompt } from "./taste-policy.js";

const SOURCE_HASH = "a".repeat(64);
const EXCERPT_HASH = "b".repeat(64);
const EVIDENCE: CreativeEvidenceRef = {
  kind: "owner_message",
  locator: "message:creative-render",
  sha256: SOURCE_HASH,
  excerptSha256: EXCERPT_HASH,
};

function section(id: string, routeId: string, order: number, kind: "hero" | "footer", interactive: boolean): CreativeSectionV1 {
  const proofId = `proof-${id}`;
  return {
    id,
    routeId,
    order,
    kind,
    job: `Give ${routeId} visitors one concrete ${kind} decision.`,
    contentRefs: [{ proofId, use: "headline" }],
    eyebrow: null,
    headline: `Specific ${kind} evidence`,
    body: interactive ? "A bounded and inspectable section body." : null,
    actions: interactive
      ? [{ id: `action-${id}`, label: "Start review", intent: "signup", priority: "primary", href: "/start", proofId }]
      : [],
    layoutFamily: kind === "hero" ? "asymmetric_split" : "footer_columns",
    visualKind: kind === "hero" ? "generated_image" : "none",
    mobile: {
      strategy: kind === "hero" ? "stack" : "preserve",
      contentOrder: [
        "headline",
        ...(interactive ? (["body"] as const) : []),
        ...(kind === "hero" ? (["visual"] as const) : []),
        ...(interactive ? (["actions"] as const) : []),
      ],
    },
    requiredStates: interactive ? ["default", "interaction"] : ["default"],
  };
}

function contractFixture(): CreativeContractV1 {
  const sections = [
    section("home-hero", "home", 0, "hero", true),
    section("home-footer", "home", 1, "footer", false),
    section("work-hero", "work", 0, "hero", false),
    section("work-footer", "work", 1, "footer", false),
  ];
  return {
    schemaVersion: 1,
    contractId: "creative-render-contract",
    designRead: {
      pageKind: "saas_landing",
      audience: "Technical owners.",
      vibe: "Direct and evidence-led.",
      aestheticFamily: "industrial",
      designSystem: "tailwind",
      displayStyle: "sans",
      paletteFamily: "neutral_pop",
      theme: "dark",
      thesis: "Every route makes the rendered result inspectable.",
    },
    dials: { designVariance: 7, motionIntensity: 6, visualDensity: 5 },
    contentProof: sections.map((item) => ({
      id: `proof-${item.id}`,
      claim: `Owner-supported claim for ${item.id}.`,
      status: "supported_paraphrase",
      evidence: EVIDENCE,
      allowedUses: item.actions.length > 0 ? ["headline", "action"] : ["headline"],
    })),
    routes: [
      { id: "home", path: "/", sectionIds: ["home-hero", "home-footer"] },
      { id: "work", path: "/work", sectionIds: ["work-hero", "work-footer"] },
    ],
    sections,
    motion: [
      {
        id: "home-action",
        routeId: "home",
        sectionId: "home-hero",
        target: "primary action",
        purpose: "feedback",
        trigger: "interaction",
        implementation: "motion",
        properties: ["transform"],
        rationale: "Confirm activation of the primary action.",
        fallback: { reducedMotion: "instant", noMedia: "not_applicable" },
        sourceStillKind: "none",
        simulationAuthorized: false,
      },
      {
        id: "work-reveal",
        routeId: "work",
        sectionId: "work-hero",
        target: "hero copy",
        purpose: "hierarchy",
        trigger: "enter_view",
        implementation: "css",
        properties: ["opacity", "transform"],
        rationale: "Reveal the route thesis before the footer.",
        fallback: { reducedMotion: "static", noMedia: "static_asset" },
        sourceStillKind: "illustration",
        simulationAuthorized: false,
      },
    ],
    intentionalExceptions: [],
  };
}

function bindingFixture(): RenderManifestBinding {
  const contract = contractFixture();
  const compiled = compileCreativeContract(JSON.stringify(contract), {
    resolve: () => ({ sha256: SOURCE_HASH, excerptSha256: EXCERPT_HASH }),
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  return { contract, contractHash: compiled.contractHash, artifactHash: "c".repeat(64) };
}

function statefulBindingFixture(): RenderManifestBinding {
  const contract = structuredClone(contractFixture()) as CreativeContractV1;
  const workHero = contract.sections.find((item) => item.id === "work-hero");
  assert.ok(workHero !== undefined);
  (workHero as { requiredStates: readonly ("default" | "loading" | "error")[] }).requiredStates = [
    "default",
    "loading",
    "error",
  ];
  const compiled = compileCreativeContract(JSON.stringify(contract), {
    resolve: () => ({ sha256: SOURCE_HASH, excerptSha256: EXCERPT_HASH }),
  });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  return { contract, contractHash: compiled.contractHash, artifactHash: "c".repeat(64) };
}

interface FakeSectionSnapshot {
  readonly sectionId: string;
  readonly routeId: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly texts: readonly string[];
  readonly motionIds: readonly string[];
  readonly stateTokens: readonly string[];
  readonly assets: readonly { readonly kind: string; readonly locator: string | null; readonly provenance: "matched" | "unknown" | "forbidden_remote" | "missing" }[];
}

interface FakeRouteSnapshot {
  readonly pathname: string;
  readonly routeMarkers: readonly string[];
  readonly sectionOrder: readonly string[];
  readonly sections: readonly FakeSectionSnapshot[];
  readonly horizontalOverflow: boolean;
}

interface FakeMotionObservation {
  readonly observedProperties: readonly ("opacity" | "transform")[];
  readonly sampleIndexes: readonly number[];
}

type FakeRouteMap = Readonly<Record<string, FakeRouteSnapshot>>;
type FakeMotionMap = Readonly<Record<string, Readonly<Record<string, FakeMotionObservation>>>>;
type FakeRouteOverrides = Partial<Record<RenderProfileId, FakeRouteMap>>;
type FakeMotionOverrides = Partial<Record<RenderProfileId, FakeMotionMap>>;

interface FakeFixture {
  readonly routes: Readonly<Record<RenderProfileId, FakeRouteMap>>;
  readonly motion: Readonly<Record<RenderProfileId, FakeMotionMap>>;
  readonly requests: readonly string[];
  readonly renderStatePixels: boolean;
  readonly renderInteractionPixels: boolean;
  readonly stateReversionsAfterSettle: Readonly<Partial<Record<string, string>>>;
  readonly stateWrites: string[];
  readonly stateRequests: Readonly<Partial<Record<string, readonly string[]>>>;
}

function routeSnapshot(routeId: string, sectionIds: readonly string[], overflow = false, width = 720): FakeRouteSnapshot {
  const sections = sectionIds.map((sectionId, index) => ({
    sectionId,
    routeId,
    box: { x: 24, y: 120 + index * 280, width, height: 220 },
    texts: [`${sectionId} headline`, `${sectionId} supporting copy`],
    motionIds: sectionId.includes("hero") ? [routeId === "home" ? "home-action" : "work-reveal"] : [],
    stateTokens: [],
    assets: sectionId.includes("hero")
      ? [{ kind: "img", locator: `/assets/${sectionId}.png`, provenance: "matched" as const }]
      : [],
  }));
  return {
    pathname: routeId === "home" ? "/" : "/work",
    routeMarkers: [routeId],
    sectionOrder: [...sectionIds],
    sections,
    horizontalOverflow: overflow,
  };
}

function fixture(overrides: {
  readonly routes?: FakeRouteOverrides;
  readonly motion?: FakeMotionOverrides;
  readonly requests?: readonly string[];
  readonly renderStatePixels?: boolean;
  readonly renderInteractionPixels?: boolean;
  readonly stateReversionsAfterSettle?: Readonly<Partial<Record<string, string>>>;
  readonly stateWrites?: string[];
  readonly stateRequests?: Readonly<Partial<Record<string, readonly string[]>>>;
} = {}): FakeFixture {
  const base: FakeFixture = {
    routes: {
      desktop: {
        "/": routeSnapshot("home", ["home-hero", "home-footer"]),
        "/work": routeSnapshot("work", ["work-hero", "work-footer"]),
      },
      mobile: {
        "/": routeSnapshot("home", ["home-hero", "home-footer"], false, 320),
        "/work": routeSnapshot("work", ["work-hero", "work-footer"], false, 320),
      },
      reduced_motion: {
        "/": routeSnapshot("home", ["home-hero", "home-footer"]),
        "/work": routeSnapshot("work", ["work-hero", "work-footer"]),
      },
      no_media: {
        "/": routeSnapshot("home", ["home-hero", "home-footer"]),
        "/work": routeSnapshot("work", ["work-hero", "work-footer"]),
      },
    },
    motion: {
      desktop: {
        home: { "home-action": { observedProperties: ["transform"], sampleIndexes: [1, 2] } },
        work: { "work-reveal": { observedProperties: ["opacity", "transform"], sampleIndexes: [3, 4] } },
      },
      mobile: {
        home: { "home-action": { observedProperties: ["transform"], sampleIndexes: [1, 2] } },
        work: { "work-reveal": { observedProperties: ["opacity", "transform"], sampleIndexes: [3, 4] } },
      },
      reduced_motion: {
        home: { "home-action": { observedProperties: [], sampleIndexes: [] } },
        work: { "work-reveal": { observedProperties: [], sampleIndexes: [] } },
      },
      no_media: {
        home: { "home-action": { observedProperties: [], sampleIndexes: [] } },
        work: { "work-reveal": { observedProperties: [], sampleIndexes: [] } },
      },
    },
    requests: [],
    renderStatePixels: true,
    renderInteractionPixels: true,
    stateReversionsAfterSettle: {},
    stateWrites: [],
    stateRequests: {},
  };
  return {
    routes: {
      desktop: overrides.routes?.desktop ?? base.routes.desktop,
      mobile: overrides.routes?.mobile ?? base.routes.mobile,
      reduced_motion: overrides.routes?.reduced_motion ?? base.routes.reduced_motion,
      no_media: overrides.routes?.no_media ?? base.routes.no_media,
    },
    motion: {
      desktop: overrides.motion?.desktop ?? base.motion.desktop,
      mobile: overrides.motion?.mobile ?? base.motion.mobile,
      reduced_motion: overrides.motion?.reduced_motion ?? base.motion.reduced_motion,
      no_media: overrides.motion?.no_media ?? base.motion.no_media,
    },
    requests: overrides.requests ?? base.requests,
    renderStatePixels: overrides.renderStatePixels ?? base.renderStatePixels,
    renderInteractionPixels: overrides.renderInteractionPixels ?? base.renderInteractionPixels,
    stateReversionsAfterSettle: overrides.stateReversionsAfterSettle ?? base.stateReversionsAfterSettle,
    stateWrites: overrides.stateWrites ?? base.stateWrites,
    stateRequests: overrides.stateRequests ?? base.stateRequests,
  };
}

class FakePage implements CreativeRenderPage {
  readonly #fixture: FakeFixture;
  readonly #profileId: RenderProfileId;
  readonly #consoleHandlers: ((message: CreativeRenderConsoleMessage) => void)[] = [];
  readonly #pageErrorHandlers: ((error: Error) => void)[] = [];
  readonly #requestHandlers: ((request: CreativeRenderRequest) => void)[] = [];
  readonly #routeHandler: ((route: CreativeRenderRoute) => Promise<unknown>) | null;
  readonly #states = new Map<string, string>();
  #hovered = "";
  currentPath = "/";
  readonly mouse = { move: async (_x: number, _y: number): Promise<void> => { this.#hovered = ""; } };

  constructor(
    fixtureData: FakeFixture,
    profileId: RenderProfileId,
    routeHandler: ((route: CreativeRenderRoute) => Promise<unknown>) | null,
  ) {
    this.#fixture = fixtureData;
    this.#profileId = profileId;
    this.#routeHandler = routeHandler;
  }

  on(event: "console", handler: (message: CreativeRenderConsoleMessage) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  on(event: "requestfailed", handler: (request: CreativeRenderRequest) => void): void;
  on(
    event: "console" | "pageerror" | "requestfailed",
    handler: ((message: CreativeRenderConsoleMessage) => void) | ((error: Error) => void) | ((request: CreativeRenderRequest) => void),
  ): void {
    if (event === "console") this.#consoleHandlers.push(handler as (message: CreativeRenderConsoleMessage) => void);
    else if (event === "pageerror") this.#pageErrorHandlers.push(handler as (error: Error) => void);
    else this.#requestHandlers.push(handler as (request: CreativeRenderRequest) => void);
  }

  async goto(url: string): Promise<{ status(): number; url(): string }> {
    const parsed = new URL(url);
    this.currentPath = parsed.pathname;
    for (const requestUrl of [url, ...this.#fixture.requests]) {
      await this.#routeHandler?.({
        request: () => ({ url: () => requestUrl, resourceType: () => "fetch", failure: () => null }),
        continue: async () => {},
        abort: async () => {},
      });
    }
    return {
      status: () => 200,
      url: () => url,
    };
  }

  async evaluate(expression: string): Promise<unknown> {
    if (expression.includes("window.__creativeRenderProbe.trace")) {
      const match = /trace\("([^"]+)"\)/u.exec(expression);
      const motionId = match?.[1] ?? "";
      const routeId = this.currentPath === "/" ? "home" : "work";
      return this.#fixture.motion[this.#profileId][routeId]?.[motionId] ?? {
        observedProperties: [],
        sampleIndexes: [],
      };
    }
    if (expression.includes("scrollIntoView")) return true;
    if (expression.includes("const requiredState =")) {
      const sectionMatch = /const sectionId = ("(?:[^"\\]|\\.)*");/u.exec(expression);
      const stateMatch = /const requiredState = ("(?:[^"\\]|\\.)*");/u.exec(expression);
      if (sectionMatch?.[1] === undefined || stateMatch?.[1] === undefined) return false;
      return this.#states.get(JSON.parse(sectionMatch[1]) as string) === JSON.parse(stateMatch[1]);
    }
    if (expression.includes("const requestedState =")) {
      const sectionMatch = /const sectionId = ("(?:[^"\\]|\\.)*");/u.exec(expression);
      const stateMatch = /const requestedState = ("(?:[^"\\]|\\.)*");/u.exec(expression);
      if (sectionMatch?.[1] === undefined || stateMatch?.[1] === undefined) return false;
      const state = JSON.parse(stateMatch[1]) as string;
      const sectionId = JSON.parse(sectionMatch[1]) as string;
      this.#states.set(sectionId, state);
      this.#fixture.stateWrites.push(`${sectionId}:${state}`);
      for (const requestUrl of this.#fixture.stateRequests[state] ?? []) {
        await this.#routeHandler?.({
          request: () => ({ url: () => requestUrl, resourceType: () => "image", failure: () => null }),
          continue: async () => {},
          abort: async () => {},
        });
      }
      return true;
    }
    if (expression.includes("data-creative-interaction-target")) return true;
    const snapshot = this.#fixture.routes[this.#profileId][this.currentPath];
    if (snapshot !== undefined) {
      return {
        ...snapshot,
        sections: snapshot.sections.map((section) => ({
          ...section,
          stateTokens: this.#states.has(section.sectionId)
            ? [...section.stateTokens, this.#states.get(section.sectionId)!]
            : section.stateTokens,
        })),
      };
    }
    return {
      pathname: this.currentPath,
      routeMarkers: [],
      sectionOrder: [],
      sections: [],
      horizontalOverflow: false,
    };
  }

  async waitForTimeout(): Promise<void> {
    for (const [sectionId, state] of this.#states) {
      const reverted = this.#fixture.stateReversionsAfterSettle[state];
      if (reverted !== undefined) this.#states.set(sectionId, reverted);
    }
  }

  async hover(selector: string): Promise<void> { this.#hovered = selector; }

  async screenshot(options: {
    readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }): Promise<Uint8Array> {
    const state = this.#fixture.renderStatePixels
      ? JSON.stringify([...this.#states.entries()].sort(([left], [right]) => left.localeCompare(right)))
      : "states-hidden";
    return new TextEncoder().encode(
      `${this.#profileId}:${this.currentPath}:${JSON.stringify(options.clip)}:${state}:${this.#fixture.renderInteractionPixels ? this.#hovered : "interaction-hidden"}`,
    );
  }

  async close(): Promise<void> {}
}

class FakeContext implements CreativeRenderContext {
  readonly #fixture: FakeFixture;
  readonly #profileId: RenderProfileId;
  #routeHandler: ((route: CreativeRenderRoute) => Promise<unknown>) | null = null;

  constructor(fixtureData: FakeFixture, profileId: RenderProfileId) {
    this.#fixture = fixtureData;
    this.#profileId = profileId;
  }

  async addInitScript(): Promise<void> {}

  async route(_url: "**/*", handler: (route: CreativeRenderRoute) => Promise<unknown>): Promise<void> {
    this.#routeHandler = handler;
  }

  async newPage(): Promise<CreativeRenderPage> {
    return new FakePage(this.#fixture, this.#profileId, this.#routeHandler);
  }

  async close(): Promise<void> {}
}

class FakeBrowser implements CreativeRenderBrowser {
  readonly #fixture: FakeFixture;

  constructor(fixtureData: FakeFixture) {
    this.#fixture = fixtureData;
  }

  async newContext(options: {
    readonly viewport: { readonly width: number; readonly height: number; readonly deviceScaleFactor: number };
    readonly reducedMotion: "reduce" | "no-preference";
    readonly serviceWorkers: "block";
  }): Promise<CreativeRenderContext> {
    const profileId = (Object.entries(REQUIRED_RENDER_PROFILES).find(([, profile]) =>
      profile.viewport.width === options.viewport.width &&
      profile.viewport.height === options.viewport.height &&
      profile.reducedMotion === (options.reducedMotion === "reduce" ? "reduce" : "no_preference"),
    )?.[0] ?? "desktop") as RenderProfileId;
    return new FakeContext(this.#fixture, profileId);
  }

  async close(): Promise<void> {}
}

test("the render browser may request only its preview origin", () => {
  const preview = "http://127.0.0.1:4321";
  assert.equal(creativeRenderRequestAllowed(preview, "http://127.0.0.1:4321/assets/app.js"), true);
  assert.equal(creativeRenderRequestAllowed(preview, "data:image/png;base64,AA=="), true);
  assert.equal(creativeRenderRequestAllowed(preview, "blob:http://127.0.0.1:4321/id"), true);
  assert.equal(creativeRenderRequestAllowed(preview, "http://127.0.0.1:4319/api/runs"), false);
  assert.equal(creativeRenderRequestAllowed(preview, "http://192.168.1.10/private"), false);
  assert.equal(creativeRenderRequestAllowed(preview, "https://example.com/pixel"), false);
});

function fakeLaunch(fixtureData: FakeFixture): LaunchCreativeRenderBrowser {
  return async () => new FakeBrowser(fixtureData);
}

function tempPreview(): { readonly previewDir: string; readonly outputDir: string; readonly preview: { readonly runId: string; readonly url: string; readonly rootDir: string } } {
  const previewDir = mkdtempSync(join(tmpdir(), "creative-render-preview-"));
  const outputDir = mkdtempSync(join(tmpdir(), "creative-render-output-"));
  writeFileSync(join(previewDir, "index.html"), "<!doctype html><html><body>preview</body></html>", "utf8");
  return {
    previewDir,
    outputDir,
    preview: {
      runId: "run-creative-render",
      url: "http://127.0.0.1:4321",
      rootDir: previewDir,
    },
  };
}

test("render capture fails closed when preview code attempts network egress", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(fixture({ requests: [
      "http://127.0.0.1:4319/api/runs",
      "http://192.168.1.10/private",
      "https://example.com/pixel",
    ] })),
    readArtifactHash: () => binding.artifactHash,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /blocked network egress/u);
  assert.ok(result.issues.some((entry) => entry.code === "BROKEN_NAVIGATION"));
});

test("refuses a stale preview tree before launching the browser", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  let launched = false;

  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: async () => {
      launched = true;
      return await fakeLaunch(fixture())();
    },
    readArtifactHash: () => "d".repeat(64),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /stale before rendered capture starts/u);
  assert.equal(launched, false);
});

test("fails closed when a required section marker is missing", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  const bad = fixture({
    routes: {
      desktop: {
        "/": routeSnapshot("home", ["home-hero"]),
        "/work": routeSnapshot("work", ["work-hero", "work-footer"]),
      },
    },
  });

  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(bad),
    readArtifactHash: () => binding.artifactHash,
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "SECTION_NOT_FOUND"));
  assert.equal(creativeRenderRefusalClass(result), "artifact_contract");
});

test("a single wrong marker is diagnosed as a mismatch, not as missing or duplicated", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  const bad = fixture({ routes: { desktop: {
    "/": routeSnapshot("home", ["r.home-hero", "home-footer"]),
    "/work": routeSnapshot("work", ["work-hero", "work-footer"]),
  } } });
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(bad),
    readArtifactHash: () => binding.artifactHash,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected home-hero/u);
  assert.match(result.reason, /found r\.home-hero/u);
  assert.doesNotMatch(result.reason, /missing|duplicated/u);
});

test("browser startup refusal remains critic infrastructure unavailable", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: async () => { throw new Error("chromium unavailable"); },
    readArtifactHash: () => binding.artifactHash,
  });
  assert.equal(result.ok, false);
  assert.equal(creativeRenderRefusalClass(result), "critic_unavailable");
});

test("a capture-only issue remains critic infrastructure unavailable", () => {
  assert.equal(creativeRenderRefusalClass({
    ok: false,
    reason: "render capture failed for home-hero: screenshot timed out",
    issues: [{
      code: "CAPTURE_FAILED",
      severity: "blocking",
      profileId: "desktop",
      routeId: "home",
      sectionId: "home-hero",
      motionId: null,
      evidenceSha256: "f".repeat(64),
    }],
  }), "critic_unavailable");
});

test("required non-default states must change the rendered pixels", async () => {
  const binding = statefulBindingFixture();
  const env = tempPreview();
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(fixture({ renderStatePixels: false })),
    readArtifactHash: () => binding.artifactHash,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /state loading is pixel-identical to its default state/u);
  assert.ok(result.issues.some((item) => item.code === "CAPTURE_FAILED"));
});

test("a state reverted by the application during settle is not reasserted before capture", async () => {
  const binding = statefulBindingFixture();
  const env = tempPreview();
  const stateWrites: string[] = [];
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(fixture({
      stateReversionsAfterSettle: { loading: "default" },
      stateWrites,
    })),
    readArtifactHash: () => binding.artifactHash,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /section work-hero did not hold state loading through its settle window/u);
  assert.equal(stateWrites.filter((write) => write === "work-hero:loading").length, 1);
});

test("an interaction state must produce pixels distinct from default", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(fixture({ renderInteractionPixels: false })),
    readArtifactHash: () => binding.artifactHash,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /section home-hero state interaction is pixel-identical to its default state/u);
});

test("state-triggered network egress is blocked and reported", async () => {
  const binding = statefulBindingFixture();
  const env = tempPreview();
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(fixture({
      stateRequests: { loading: ["https://example.com/state-pixel.png"] },
    })),
    readArtifactHash: () => binding.artifactHash,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /blocked network egress/u);
  assert.ok(result.issues.some((item) => item.code === "BROKEN_NAVIGATION"));
});

test("real Chromium captures below-fold, oversized sections and host-driven states", async () => {
  const binding = statefulBindingFixture();
  const env = tempPreview();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const work = pathname === "/work";
    const routeId = work ? "work" : "home";
    const sections = work
      ? `<section class="stateful" data-creative-section="work-hero" data-creative-state="default">
           <div data-motion-id="work-reveal">A below-fold, oversized stateful hero.</div>
         </section>
         <footer data-creative-section="work-footer">Work footer</footer>`
      : `<section class="home" data-creative-section="home-hero" data-creative-state="default">
           <a href="/start" data-motion-id="home-action">Start review</a>
           <img alt="Measured reference" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='white'/%3E%3C/svg%3E">
         </section>
         <footer data-creative-section="home-footer">Home footer</footer>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><style>
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body { margin: 0; background: rgb(12, 12, 12); color: white; }
        main { min-height: 15000px; }
        section, footer { padding: 32px; }
        .home { height: 700px; background: rgb(60, 20, 20); }
        .home a { display: inline-block; padding: 20px; color: white; background: rgb(20, 50, 90); transition: transform 80ms linear; }
        .home a:hover { background: rgb(110, 70, 10); transform: translateX(8px); }
        .stateful { margin-top: 12000px; min-height: 1600px; }
        .stateful[data-creative-state="default"] { background: rgb(80, 20, 20); }
        .stateful[data-creative-state="loading"] { background: rgb(20, 80, 20); }
        .stateful[data-creative-state="error"] { background: rgb(20, 20, 80); }
        footer { height: 180px; background: rgb(35, 35, 35); }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; transform: none !important; } }
      </style></head>
      <body><main data-creative-route="${routeId}">${sections}</main>
      <script>
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const reveal = document.querySelector('[data-motion-id="work-reveal"]');
          if (reveal) {
            setTimeout(() => { reveal.style.opacity = '0.7'; reveal.style.transform = 'translateX(6px)'; }, 20);
            setTimeout(() => { reveal.style.opacity = '1'; reveal.style.transform = 'translateX(0px)'; }, 70);
          }
        }
      </script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  try {
    const result = await captureCreativeRender({
      preview: { ...env.preview, url: `http://127.0.0.1:${String(address.port)}` },
      binding,
      iteration: 0,
      outputDir: env.outputDir,
      readArtifactHash: () => binding.artifactHash,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.output.manifest.captures.length, 28);
    for (const capture of result.output.manifest.captures) {
      const region = capture.regions[0];
      assert.ok(region !== undefined);
      const viewport = REQUIRED_RENDER_PROFILES[capture.profileId].viewport;
      assert.equal(region.box.x, 0);
      assert.equal(region.box.y, 0);
      assert.ok(region.box.width <= viewport.width);
      assert.ok(region.box.height <= viewport.height);
    }
    for (const profileId of Object.keys(REQUIRED_RENDER_PROFILES) as RenderProfileId[]) {
      const captures: readonly RenderCaptureV1[] = result.output.manifest.captures.filter((capture: RenderCaptureV1) =>
        capture.profileId === profileId && capture.sectionId === "work-hero");
      assert.equal(new Set(captures.map((capture) => capture.screenshotSha256)).size, 3);
    }
    assert.ok(result.output.facts.some((fact) =>
      fact.observation.includes("desktop work/work-hero state loading")));
    const loading = result.output.manifest.captures.find((capture) =>
      capture.profileId === "desktop" && capture.sectionId === "work-hero" && capture.state === "loading");
    assert.ok(loading !== undefined);
    assert.ok(result.output.evidenceIndex.evidence.some((evidence) =>
      evidence.kind === "region" && evidence.screenshotSha256 === loading.screenshotSha256));
    const factKinds = new Set(result.output.facts.map((fact) => fact.evidence.kind));
    for (const kind of ["contract", "region", "dom_text", "asset", "motion_trace"] as const) {
      assert.ok(factKinds.has(kind), `critic facts retain ${kind}`);
    }
    for (const profileId of Object.keys(REQUIRED_RENDER_PROFILES) as RenderProfileId[]) {
      assert.ok(result.output.facts.some((fact) =>
        fact.evidence.kind === "region" && fact.evidence.frameId.startsWith(`${profileId}:`)));
    }
    assert.ok(result.output.facts.some((fact) => fact.observation.includes("state interaction")));
    assert.ok(result.output.facts.some((fact) => fact.observation.includes("state error")));
    assert.doesNotThrow(() => buildTasteCriticPrompt(buildCreativeTastePromptInput(result.output, binding.contract)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fails closed when reduced-motion captures still observe active motion", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  const bad = fixture({
    motion: {
      reduced_motion: {
        home: { "home-action": { observedProperties: ["transform"], sampleIndexes: [5] } },
        work: { "work-reveal": { observedProperties: ["opacity"], sampleIndexes: [7] } },
      },
    },
  });

  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(bad),
    readArtifactHash: () => binding.artifactHash,
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "REDUCED_MOTION_ACTIVE"));
});

test("captures a valid manifest and projects bounded taste evidence and facts", async () => {
  const binding = bindingFixture();
  const env = tempPreview();

  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 1,
    outputDir: env.outputDir,
    launch: fakeLaunch(fixture()),
    readArtifactHash: () => binding.artifactHash,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.output.renderManifestHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.output.manifest.contractHash, binding.contractHash);
  assert.ok(result.output.files.every((item) => !item.relativePath.startsWith("/")));
  assert.ok(result.output.evidenceIndex.frames.some((item) => item.id === "desktop:home"));
  assert.ok(result.output.facts.length > 0);

  const promptInput = buildCreativeTastePromptInput(result.output, binding.contract);
  assert.equal(promptInput.evidenceIndex.renderManifestHash, result.output.renderManifestHash);
  assert.deepEqual(promptInput.intentionalExceptions, []);
});

test("builds taste evidence indexes and facts from a captured manifest without exposing raw paths", async () => {
  const binding = bindingFixture();
  const env = tempPreview();
  const result = await captureCreativeRender({
    preview: env.preview,
    binding,
    iteration: 0,
    outputDir: env.outputDir,
    launch: fakeLaunch(fixture()),
    readArtifactHash: () => binding.artifactHash,
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const longTraceManifest = structuredClone(result.output.manifest) as RenderManifestV1 & {
    motionTraces: { sampleIndexes: number[] }[];
  };
  assert.ok(longTraceManifest.motionTraces[0] !== undefined);
  longTraceManifest.motionTraces[0].sampleIndexes = Array.from({ length: 16 }, (_, index) => index);

  const evidenceIndex = buildTasteEvidenceIndex(
    binding.contract,
    longTraceManifest,
    result.output.renderManifestHash,
  );
  assert.ok(evidenceIndex.evidence.some((item) => item.kind === "dom_text"));
  assert.ok(evidenceIndex.evidence.some((item) => item.kind === "contract"));
  assert.ok(evidenceIndex.contractPointers.every((item) => !item.includes(env.outputDir)));
  assert.ok(evidenceIndex.evidence.every((item) => item.kind !== "motion_trace" || item.sampleIndexes.length <= 8));
  assert.ok(evidenceIndex.evidence.every((item) => item.kind !== "motion_trace" || item.observedProperties.length > 0));

  const facts = buildTastePromptFacts(
    binding.contract,
    longTraceManifest,
    result.output.renderManifestHash,
  );
  assert.ok(facts.every((item) => !item.observation.includes(env.outputDir)));
  assert.ok(facts.every((item) => item.evidence.kind !== "motion_trace" || item.evidence.sampleIndexes.length <= 8));
  assert.ok(facts.every((item) => item.evidence.kind !== "motion_trace" || item.evidence.observedProperties.length > 0));
  const projectedLongTrace = facts.find((item) =>
    item.evidence.kind === "motion_trace" && item.evidence.motionId === longTraceManifest.motionTraces[0]!.motionId);
  assert.ok(projectedLongTrace !== undefined);
  assert.match(projectedLongTrace.observation, /at samples 0, 1, 2, 3, 4, 5, 6, 7\.$/u);
  assert.doesNotMatch(projectedLongTrace.observation, /at samples [^.]*\b(?:8|9|1[0-5])\b/u);
});
