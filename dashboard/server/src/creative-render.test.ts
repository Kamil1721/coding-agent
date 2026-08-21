import { mkdtempSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
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
import type { RenderManifestBinding, RenderProfileId } from "./render-manifest.js";

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
  };
}

class FakePage implements CreativeRenderPage {
  readonly #fixture: FakeFixture;
  readonly #profileId: RenderProfileId;
  readonly #consoleHandlers: ((message: CreativeRenderConsoleMessage) => void)[] = [];
  readonly #pageErrorHandlers: ((error: Error) => void)[] = [];
  readonly #requestHandlers: ((request: CreativeRenderRequest) => void)[] = [];
  readonly #routeHandler: ((route: CreativeRenderRoute) => Promise<unknown>) | null;
  currentPath = "/";

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
    if (expression.includes("querySelector('[data-state=")) return false;
    const snapshot = this.#fixture.routes[this.#profileId][this.currentPath];
    return snapshot ?? {
      pathname: this.currentPath,
      routeMarkers: [],
      sectionOrder: [],
      sections: [],
      horizontalOverflow: false,
    };
  }

  async waitForTimeout(): Promise<void> {}

  async hover(): Promise<void> {}

  async screenshot(): Promise<Uint8Array> {
    return new TextEncoder().encode(`${this.#profileId}:${this.currentPath}`);
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

  const evidenceIndex = buildTasteEvidenceIndex(
    binding.contract,
    result.output.manifest,
    result.output.renderManifestHash,
  );
  assert.ok(evidenceIndex.evidence.some((item) => item.kind === "dom_text"));
  assert.ok(evidenceIndex.contractPointers.every((item) => !item.includes(env.outputDir)));

  const facts = buildTastePromptFacts(
    binding.contract,
    result.output.manifest,
    result.output.renderManifestHash,
  );
  assert.ok(facts.every((item) => !item.observation.includes(env.outputDir)));
});
