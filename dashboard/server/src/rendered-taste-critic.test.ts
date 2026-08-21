import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT } from "bakeoff/dist/config.js";
import { DASHBOARD_BUDGET } from "./orchestrator.js";
import {
  CREATIVE_CRITIC_DIRECTORY,
  fingerprintTasteFindings,
  readRenderedTasteCriticRecord,
  runRenderedTasteCritic,
  writeRenderedTasteCriticRecord,
} from "./rendered-taste-critic.js";
import type { RenderedTasteCriticRequest } from "./rendered-taste-critic.js";
import type { SeatImage, SeatSessionFactory } from "./subscription-caller.js";
import type { TasteCriticPromptInput, TasteFindingV1 } from "./taste-policy.js";

const CONTRACT_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);
const TREE_HASH = "c".repeat(64);
const SEAT: AnthropicSeat = { ...JUDGE_SEAT, modelId: "default", effort: "low" };
const FIRST_EVIDENCE = {
  kind: "dom_text" as const,
  frameId: "frame-desktop",
  sectionId: "hero",
  excerpt: "Everything you need to grow",
  textSha256: "d".repeat(64),
};
const SECOND_EVIDENCE = {
  kind: "region" as const,
  frameId: "frame-desktop",
  sectionId: "hero",
  screenshotSha256: "e".repeat(64),
  box: { x: 0, y: 0, width: 800, height: 500 },
};

const PROMPT: TasteCriticPromptInput = {
  evidenceIndex: {
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    routes: [{ id: "home", sectionIds: ["hero"] }],
    frames: [{ id: "frame-desktop", routeId: "home", sectionIds: ["hero"], motionIds: [] }],
    contractPointers: [],
    evidence: [FIRST_EVIDENCE, SECOND_EVIDENCE],
  },
  facts: [
    { id: "copy", evidence: FIRST_EVIDENCE, observation: "The hero uses a generic growth claim." },
    { id: "region", evidence: SECOND_EVIDENCE, observation: "The claim dominates the hero region." },
  ],
  intentionalExceptions: [],
};

interface Dispatch {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}

function envelope(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

function recordingQuery(result: string): { readonly factory: SeatSessionFactory; readonly dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const factory: SeatSessionFactory = ({ prompt, options }) => {
    dispatches.push({ prompt, options });
    return (async function* replay(): AsyncGenerator<SDKMessage, void> {
      yield envelope({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    })();
  };
  return { factory, dispatches };
}

const IMAGE: SeatImage = {
  label: "desktop.png",
  mediaType: "image/png",
  block: { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
  declined: null,
};

function request(startQuery: SeatSessionFactory, images: readonly SeatImage[] = []): RenderedTasteCriticRequest {
  return {
    attempt: 1,
    iteration: 1,
    treeHash: TREE_HASH,
    prompt: PROMPT,
    images,
    seat: SEAT,
    budget: DASHBOARD_BUDGET,
    cwd: tmpdir(),
    env: {},
    signal: new AbortController().signal,
    startQuery,
    clock: () => new Date("2026-08-20T12:00:00.000Z"),
  };
}

test("the critic is one independent tool-less call and host images travel only as native content", async () => {
  const output = JSON.stringify({
    schemaVersion: 1,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    findings: [],
  });
  const recorder = recordingQuery(output);

  const record = await runRenderedTasteCritic(request(recorder.factory, [IMAGE]));

  assert.equal(record.criticDisposition, "accept");
  assert.equal(record.ran, true);
  assert.equal(recorder.dispatches.length, 1, "one critic attempt is one fresh seat call");
  const dispatch = recorder.dispatches[0];
  assert.ok(dispatch !== undefined);
  assert.deepEqual(dispatch.options.tools, []);
  assert.deepEqual(dispatch.options.settingSources, []);
  assert.equal(typeof dispatch.prompt, "object", "native image content requires the SDK streaming prompt shape");
  const prompt = dispatch.prompt as AsyncIterable<SDKUserMessage>;
  const first = await prompt[Symbol.asyncIterator]().next();
  assert.equal(first.done, false);
  const content = first.value?.message.content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.type, "image");
  assert.doesNotMatch(JSON.stringify(content), /\/Users\/|workspace|screenshotPath/);
});

test("closed-policy failures and session errors are unavailable records, never thrown", async () => {
  const invalid = recordingQuery("looks good");
  const invalidRecord = await runRenderedTasteCritic(request(invalid.factory));
  assert.equal(invalidRecord.criticDisposition, "unavailable");
  assert.equal(invalidRecord.ran, true);
  assert.equal(invalidRecord.policyErrors[0]?.code, "INVALID_JSON");

  const throwing: SeatSessionFactory = () => {
    throw new Error("session unavailable");
  };
  const failedRecord = await runRenderedTasteCritic(request(throwing));
  assert.equal(failedRecord.criticDisposition, "unavailable");
  assert.equal(failedRecord.ran, false);
  assert.match(failedRecord.detail, /session unavailable/);

  const outOfRange = await runRenderedTasteCritic({ ...request(throwing), attempt: 4 });
  assert.equal(outOfRange.criticDisposition, "unavailable");
  assert.equal(outOfRange.ran, false);
  assert.match(outOfRange.detail, /1-3/);

  const brokenClock = await runRenderedTasteCritic({
    ...request(throwing),
    clock: () => {
      throw new Error("clock unavailable");
    },
  });
  assert.equal(brokenClock.criticDisposition, "unavailable");
  assert.match(brokenClock.detail, /clock unavailable/);
});

test("critic records round-trip by bounded iteration and unreadable bytes fail closed", async () => {
  const recorder = recordingQuery(JSON.stringify({
    schemaVersion: 1,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    findings: [],
  }));
  const record = await runRenderedTasteCritic(request(recorder.factory));
  const directory = mkdtempSync(join(tmpdir(), "dash-critic-record-"));
  try {
    const path = writeRenderedTasteCriticRecord(directory, record);
    assert.equal(path, join(directory, CREATIVE_CRITIC_DIRECTORY, "1.json"));
    assert.deepEqual(readRenderedTasteCriticRecord(directory, 1), record);
    writeFileSync(path, "{not json", "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);
    assert.throws(() => readRenderedTasteCriticRecord(directory, 4), /0-3/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("finding fingerprints ignore model ids and finding order", () => {
  const finding = (id: string, diagnosis: string): TasteFindingV1 => ({
    id,
    category: "copy",
    code: "GENERIC_COPY",
    routeId: "home",
    sectionIds: ["hero"],
    diagnosis,
    revision: "Replace the claim with concrete proof.",
    evidence: [FIRST_EVIDENCE, SECOND_EVIDENCE],
  });
  const first = finding("model-id-1", "The hero claim is generic.");
  const second = finding("model-id-2", "The proof line is generic.");
  assert.equal(
    fingerprintTasteFindings([first, second]),
    fingerprintTasteFindings([{ ...second, id: "changed" }, { ...first, id: "also-changed" }]),
  );
  assert.notEqual(fingerprintTasteFindings([first]), fingerprintTasteFindings([second]));
});
