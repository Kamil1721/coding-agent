import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { JUDGE_SEAT } from "bakeoff/dist/config.js";
import { DASHBOARD_BUDGET } from "./orchestrator.js";
import {
  CREATIVE_CRITIC_DIRECTORY,
  criticRecordPath,
  fingerprintTasteFindings,
  hasRenderedTasteCriticArtifact,
  readRenderedTasteCriticHistory,
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

function authorityRecord(
  attempt: number,
  disposition: "accept" | "no_evidence" | "unavailable" = "accept",
  contractHash = CONTRACT_HASH,
): import("./rendered-taste-critic.js").RenderedTasteCriticRecord {
  const output = disposition === "unavailable" ? null : {
    schemaVersion: 2 as const,
    contractHash,
    renderManifestHash: MANIFEST_HASH,
    evidenceSufficient: disposition === "accept",
    findings: [],
  };
  return {
    schemaVersion: 1,
    attempt,
    iteration: attempt - 1,
    treeHash: TREE_HASH,
    contractHash,
    renderManifestHash: MANIFEST_HASH,
    recordedAt: "2026-08-20T12:00:00.000Z",
    criticDisposition: disposition,
    ran: disposition !== "unavailable",
    output,
    findingFingerprint: output === null ? null : fingerprintTasteFindings([]),
    policyErrors: [],
    detail: `fixture ${disposition}`,
    tokens: null,
    rateLimit: null,
    criticBy: "test/critic-history",
  };
}

test("critic artifact presence fails closed for every node at the authority path", () => {
  const root = mkdtempSync(join(tmpdir(), "dash-critic-presence-"));
  try {
    assert.equal(hasRenderedTasteCriticArtifact(root), false);

    const authorityPath = join(root, CREATIVE_CRITIC_DIRECTORY);
    mkdirSync(authorityPath);
    assert.equal(hasRenderedTasteCriticArtifact(root), true, "an empty authority directory is still evidence");
    writeFileSync(join(authorityPath, "malformed.json"), "not json", "utf8");
    assert.equal(hasRenderedTasteCriticArtifact(root), true, "malformed contents remain evidence");

    rmSync(authorityPath, { recursive: true });
    writeFileSync(authorityPath, "not a directory", "utf8");
    assert.equal(hasRenderedTasteCriticArtifact(root), true, "a file at the authority path remains evidence");

    rmSync(authorityPath);
    symlinkSync(join(root, "missing-target"), authorityPath);
    assert.equal(hasRenderedTasteCriticArtifact(root), true, "a dangling symlink remains evidence without traversal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict critic history accepts only contiguous canonical append-only authority", () => {
  const absent = mkdtempSync(join(tmpdir(), "dash-critic-history-absent-"));
  assert.deepEqual(readRenderedTasteCriticHistory(absent), []);

  const valid = mkdtempSync(join(tmpdir(), "dash-critic-history-valid-"));
  try {
    const first = authorityRecord(1);
    writeRenderedTasteCriticRecord(valid, first);
    assert.deepEqual(readRenderedTasteCriticHistory(valid), [first]);
    const persisted = readFileSync(criticRecordPath(valid, 0), "utf8");
    assert.throws(() => writeRenderedTasteCriticRecord(valid, authorityRecord(1, "no_evidence")), /EEXIST/u);
    assert.equal(readFileSync(criticRecordPath(valid, 0), "utf8"), persisted, "append-only writer never replaces authority");

    const second = authorityRecord(2, "unavailable");
    writeRenderedTasteCriticRecord(valid, second);
    assert.deepEqual(readRenderedTasteCriticHistory(valid), [first, second]);
    writeRenderedTasteCriticRecord(valid, authorityRecord(3));
    assert.equal(readRenderedTasteCriticHistory(valid), null, "terminal unavailable cannot have a later record");
  } finally {
    rmSync(absent, { recursive: true, force: true });
    rmSync(valid, { recursive: true, force: true });
  }
});

test("strict critic history rejects ambiguous filesystem and sequence shapes", () => {
  const invalidCases: readonly ((root: string) => void)[] = [
    (root) => mkdirSync(join(root, CREATIVE_CRITIC_DIRECTORY)),
    (root) => writeFileSync(join(root, CREATIVE_CRITIC_DIRECTORY), "not a directory", "utf8"),
    (root) => symlinkSync(join(root, "missing"), join(root, CREATIVE_CRITIC_DIRECTORY)),
    (root) => { mkdirSync(join(root, CREATIVE_CRITIC_DIRECTORY)); writeFileSync(join(root, CREATIVE_CRITIC_DIRECTORY, "3.json"), "{}", "utf8"); },
    (root) => { mkdirSync(join(root, CREATIVE_CRITIC_DIRECTORY)); writeFileSync(join(root, CREATIVE_CRITIC_DIRECTORY, ".0.tmp"), "{}", "utf8"); },
    (root) => { mkdirSync(join(root, CREATIVE_CRITIC_DIRECTORY, "0.json"), { recursive: true }); },
    (root) => { mkdirSync(join(root, CREATIVE_CRITIC_DIRECTORY)); symlinkSync(join(root, "missing"), join(root, CREATIVE_CRITIC_DIRECTORY, "0.json")); },
    (root) => { mkdirSync(join(root, CREATIVE_CRITIC_DIRECTORY)); writeFileSync(join(root, CREATIVE_CRITIC_DIRECTORY, "0.json"), "not json", "utf8"); },
    (root) => {
      mkdirSync(join(root, CREATIVE_CRITIC_DIRECTORY));
      writeFileSync(join(root, CREATIVE_CRITIC_DIRECTORY, "0.json"), JSON.stringify({ ...authorityRecord(2), iteration: 0 }), "utf8");
    },
    (root) => writeRenderedTasteCriticRecord(root, authorityRecord(2)),
    (root) => { writeRenderedTasteCriticRecord(root, authorityRecord(1)); writeRenderedTasteCriticRecord(root, authorityRecord(2, "accept", "d".repeat(64))); },
    (root) => { writeRenderedTasteCriticRecord(root, authorityRecord(1, "no_evidence")); writeRenderedTasteCriticRecord(root, authorityRecord(2)); },
  ];
  for (const [index, arrange] of invalidCases.entries()) {
    const root = mkdtempSync(join(tmpdir(), `dash-critic-history-invalid-${String(index)}-`));
    try {
      arrange(root);
      assert.equal(readRenderedTasteCriticHistory(root), null, `invalid history case ${String(index)}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  assert.throws(() => criticRecordPath("/tmp", 3), /0-2/u);
});

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
    schemaVersion: 2,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    evidenceSufficient: true,
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

test("an empty live result is no_evidence or accept according to the explicit evidence signal", async () => {
  const noEvidence = recordingQuery(JSON.stringify({
    schemaVersion: 2,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    evidenceSufficient: false,
    findings: [],
  }));
  const noEvidenceRecord = await runRenderedTasteCritic(request(noEvidence.factory));
  assert.equal(noEvidenceRecord.criticDisposition, "no_evidence");
  assert.match(noEvidenceRecord.detail, /evidence was insufficient/u);
  const directory = mkdtempSync(join(tmpdir(), "dash-critic-no-evidence-record-"));
  try {
    const path = writeRenderedTasteCriticRecord(directory, noEvidenceRecord);
    assert.equal(readRenderedTasteCriticRecord(directory, 1)?.criticDisposition, "no_evidence");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      output: Record<string, unknown>;
    };
    const missing = structuredClone(persisted);
    delete missing.output["evidenceSufficient"];
    writeFileSync(path, JSON.stringify(missing), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);

    const malformed = structuredClone(persisted);
    malformed.output["evidenceSufficient"] = "no";
    writeFileSync(path, JSON.stringify(malformed), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);

    const inconsistent = structuredClone(persisted);
    inconsistent.output["evidenceSufficient"] = true;
    writeFileSync(path, JSON.stringify(inconsistent), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const accepted = recordingQuery(JSON.stringify({
    schemaVersion: 2,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    evidenceSufficient: true,
    findings: [],
  }));
  assert.equal((await runRenderedTasteCritic(request(accepted.factory))).criticDisposition, "accept");
});

test("closed-policy failures and session errors are unavailable records, never thrown", async () => {
  const invalid = recordingQuery("looks good");
  const invalidRecord = await runRenderedTasteCritic(request(invalid.factory));
  assert.equal(invalidRecord.criticDisposition, "unavailable");
  assert.equal(invalidRecord.ran, true);
  assert.equal(invalidRecord.policyErrors[0]?.code, "INVALID_JSON");

  const inconsistent = recordingQuery(JSON.stringify({
    schemaVersion: 2,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    evidenceSufficient: false,
    findings: [{
      id: "copy",
      category: "copy",
      code: "GENERIC_COPY",
      routeId: "home",
      sectionIds: ["hero"],
      diagnosis: "The hero claim is generic.",
      revision: "Replace it with admitted proof.",
      evidence: [FIRST_EVIDENCE, SECOND_EVIDENCE],
    }],
  }));
  const inconsistentRecord = await runRenderedTasteCritic(request(inconsistent.factory));
  assert.equal(inconsistentRecord.criticDisposition, "unavailable");
  assert.ok(inconsistentRecord.policyErrors.some((error) => error.path === "/evidenceSufficient"));

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
    schemaVersion: 2,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    evidenceSufficient: true,
    findings: [],
  }));
  const record = await runRenderedTasteCritic(request(recorder.factory));
  const directory = mkdtempSync(join(tmpdir(), "dash-critic-record-"));
  try {
    const path = writeRenderedTasteCriticRecord(directory, record);
    assert.equal(path, join(directory, CREATIVE_CRITIC_DIRECTORY, "1.json"));
    assert.deepEqual(readRenderedTasteCriticRecord(directory, 1), record);

    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...persisted, findingFingerprint: "f".repeat(64) }), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);
    writeFileSync(path, JSON.stringify({ ...persisted, output: {
      ...(persisted["output"] as Record<string, unknown>),
      findings: [null],
    } }), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);
    writeFileSync(path, JSON.stringify({ ...persisted, ran: false }), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);
    writeFileSync(path, JSON.stringify({ ...persisted, policyErrors: [{
      code: "INVALID_VALUE",
      path: "/",
      message: "completed records cannot carry policy errors",
    }] }), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);

    writeFileSync(path, "{not json", "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);
    assert.throws(() => readRenderedTasteCriticRecord(directory, 3), /0-2/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the stored-record reader accepts nested schema 1 without rewriting its recorded disposition", () => {
  const directory = mkdtempSync(join(tmpdir(), "dash-critic-legacy-record-"));
  const path = join(directory, CREATIVE_CRITIC_DIRECTORY, "1.json");
  const legacyFinding: TasteFindingV1 = {
    id: "legacy-revision",
    category: "copy",
    code: "GENERIC_COPY",
    routeId: "home",
    sectionIds: ["hero"],
    diagnosis: "The legacy critic found a generic hero claim.",
    revision: "Replace the claim with the admitted proof.",
    evidence: [FIRST_EVIDENCE, SECOND_EVIDENCE],
  };
  const legacyRecord = {
    schemaVersion: 1,
    attempt: 1,
    iteration: 1,
    treeHash: TREE_HASH,
    contractHash: CONTRACT_HASH,
    renderManifestHash: MANIFEST_HASH,
    recordedAt: "2026-08-20T12:00:00.000Z",
    criticDisposition: "accept",
    ran: true,
    output: {
      schemaVersion: 1,
      contractHash: CONTRACT_HASH,
      renderManifestHash: MANIFEST_HASH,
      findings: [] as TasteFindingV1[],
    },
    findingFingerprint: fingerprintTasteFindings([]),
    policyErrors: [],
    detail: "legacy critic accepted the rendered evidence",
    tokens: null,
    rateLimit: null,
    criticBy: "test/legacy-rendered-taste-critic",
  };
  try {
    mkdirSync(join(directory, CREATIVE_CRITIC_DIRECTORY));
    writeFileSync(path, JSON.stringify(legacyRecord), "utf8");
    const record = readRenderedTasteCriticRecord(directory, 1);
    assert.ok(record !== null);
    assert.equal(record.output?.schemaVersion, 1);
    assert.equal(record.criticDisposition, "accept");

    const legacyRevision = structuredClone(legacyRecord);
    legacyRevision.criticDisposition = "revise";
    legacyRevision.output.findings = [legacyFinding];
    legacyRevision.findingFingerprint = fingerprintTasteFindings([legacyFinding]);
    legacyRevision.detail = "legacy critic requested bounded revisions";
    writeFileSync(path, JSON.stringify(legacyRevision), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1)?.criticDisposition, "revise");

    const duplicateId = structuredClone(legacyRevision);
    duplicateId.output.findings.push({
      ...legacyFinding,
      diagnosis: "A second semantic finding reused the first finding id.",
      revision: "Keep each durable finding id unique.",
    });
    duplicateId.findingFingerprint = fingerprintTasteFindings(duplicateId.output.findings);
    writeFileSync(path, JSON.stringify(duplicateId), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);

    const masquerading = structuredClone(legacyRecord) as Record<string, unknown>;
    masquerading["criticDisposition"] = "no_evidence";
    writeFileSync(path, JSON.stringify(masquerading), "utf8");
    assert.equal(readRenderedTasteCriticRecord(directory, 1), null);
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
