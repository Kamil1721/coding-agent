import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CONTEXT7_REVIEW_RECORD_FILE,
  readContext7ReviewRecord,
  writeContext7ReviewRecord,
} from "./context7-review-record.js";
import type { Context7ReviewRecord } from "./context7-review-record.js";
import { expectedContext7ObligationHashes } from "./context7-review.js";

function record(): Context7ReviewRecord {
  const value: Context7ReviewRecord = {
    schemaVersion: 1,
    startedAt: "2026-08-20T10:00:00.000Z",
    completedAt: "2026-08-20T10:00:02.000Z",
    scope: {
      projectId: "coding-agent",
      claims: [
        {
          kind: "external",
          id: "EC-1",
          package: "next",
          versionOrRange: "16.x",
          queryPurpose: "Verify current Next.js usage.",
        },
      ],
    },
    source: { sourceHash: "a".repeat(64), files: ["package.json", "app/page.tsx"], bytes: 321, truncated: false },
    outcome: {
      status: "completed",
      capabilityApplicability: "required",
      code: null,
      verdict: { verdict: "pass", summary: "Current APIs confirmed.", findings: [], evidence: [{ claimId: "EC-1" }] },
      evidence: [
        {
          claimId: "EC-1",
          package: "next",
          versionOrRange: "16.x",
          queryPurpose: "Verify current Next.js usage.",
          success: true,
          evidenceHash: "b".repeat(64),
          seat: "independent_code_review",
        },
      ],
      lifecycle: [
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: null,
          claimId: null,
          state: "planned",
          code: null,
          producedArtefactHashes: [],
        },
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: null,
          claimId: null,
          state: "granted",
          code: null,
          producedArtefactHashes: [],
        },
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: null,
          claimId: null,
          state: "connected",
          code: null,
          producedArtefactHashes: [],
        },
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: "mcp__context7__resolve-library-id",
          claimId: "EC-1",
          state: "attempted",
          code: null,
          producedArtefactHashes: [],
        },
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: "mcp__context7__resolve-library-id",
          claimId: "EC-1",
          state: "succeeded",
          code: null,
          producedArtefactHashes: ["c".repeat(64)],
        },
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: "mcp__context7__query-docs",
          claimId: "EC-1",
          state: "attempted",
          code: null,
          producedArtefactHashes: [],
        },
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: "mcp__context7__query-docs",
          claimId: "EC-1",
          state: "succeeded",
          code: null,
          producedArtefactHashes: ["b".repeat(64)],
        },
        {
          seat: "independent_code_review",
          obligationHash: "c".repeat(64),
          server: "context7",
          tool: null,
          claimId: null,
          state: "satisfied",
          code: null,
          producedArtefactHashes: ["b".repeat(64)],
        },
      ],
    },
  };
  const obligationHash = expectedContext7ObligationHashes(value.scope)[0];
  assert.ok(obligationHash);
  return {
    ...value,
    outcome: {
      ...value.outcome,
      lifecycle: value.outcome.lifecycle.map((row) => ({ ...row, obligationHash })),
    },
  };
}

type DurableLifecycle = Context7ReviewRecord["outcome"]["lifecycle"][number];

function lifecycleRow(
  obligationHash: string,
  state: DurableLifecycle["state"],
  tool: string | null,
  claimId: string | null,
  code: DurableLifecycle["code"] = null,
  producedArtefactHashes: readonly string[] = [],
): DurableLifecycle {
  return {
    seat: "independent_code_review",
    obligationHash,
    claimId,
    server: "context7",
    tool,
    state,
    code,
    producedArtefactHashes,
  };
}

function twoClaimRecord(): Context7ReviewRecord {
  const scope: Context7ReviewRecord["scope"] = {
    projectId: "coding-agent",
    claims: [
      {
        kind: "external",
        id: "EC-1",
        package: "next",
        versionOrRange: "16.x",
        queryPurpose: "Verify current Next.js usage.",
      },
      {
        kind: "external",
        id: "EC-2",
        package: "react",
        versionOrRange: "19.x",
        queryPurpose: "Verify current React usage.",
      },
    ],
  };
  const obligationHash = expectedContext7ObligationHashes(scope)[0];
  assert.ok(obligationHash);
  return {
    schemaVersion: 1,
    startedAt: "2026-08-20T10:00:00.000Z",
    completedAt: "2026-08-20T10:00:02.000Z",
    scope,
    source: { sourceHash: "a".repeat(64), files: ["package.json"], bytes: 128, truncated: false },
    outcome: {
      status: "completed",
      capabilityApplicability: "required",
      code: null,
      verdict: {
        verdict: "pass",
        summary: "Both claims were checked.",
        findings: [],
        evidence: [{ claimId: "EC-1" }, { claimId: "EC-2" }],
      },
      evidence: [
        {
          claimId: "EC-1",
          package: "next",
          versionOrRange: "16.x",
          queryPurpose: "Verify current Next.js usage.",
          success: true,
          evidenceHash: "b".repeat(64),
          seat: "independent_code_review",
        },
        {
          claimId: "EC-2",
          package: "react",
          versionOrRange: "19.x",
          queryPurpose: "Verify current React usage.",
          success: true,
          evidenceHash: "d".repeat(64),
          seat: "independent_code_review",
        },
      ],
      lifecycle: [
        lifecycleRow(obligationHash, "planned", null, null),
        lifecycleRow(obligationHash, "granted", null, null),
        lifecycleRow(obligationHash, "connected", null, null),
        lifecycleRow(obligationHash, "attempted", "mcp__context7__resolve-library-id", "EC-1"),
        lifecycleRow(obligationHash, "succeeded", "mcp__context7__resolve-library-id", "EC-1", null, ["c".repeat(64)]),
        lifecycleRow(obligationHash, "attempted", "mcp__context7__query-docs", "EC-1"),
        lifecycleRow(obligationHash, "failed", "mcp__context7__query-docs", "EC-1", "tool_error"),
        lifecycleRow(obligationHash, "attempted", "mcp__context7__query-docs", "EC-1"),
        lifecycleRow(obligationHash, "succeeded", "mcp__context7__query-docs", "EC-1", null, ["b".repeat(64)]),
        lifecycleRow(obligationHash, "attempted", "mcp__context7__resolve-library-id", "EC-2"),
        lifecycleRow(obligationHash, "succeeded", "mcp__context7__resolve-library-id", "EC-2", null, ["e".repeat(64)]),
        lifecycleRow(obligationHash, "attempted", "mcp__context7__query-docs", "EC-2"),
        lifecycleRow(obligationHash, "succeeded", "mcp__context7__query-docs", "EC-2", null, ["d".repeat(64)]),
        lifecycleRow(obligationHash, "satisfied", null, null, null, ["b".repeat(64), "d".repeat(64)]),
      ],
    },
  };
}

test("the durable record round-trips without persisting raw source or documentation", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-"));
  try {
    const value = record();
    writeContext7ReviewRecord(dir, value);
    assert.deepEqual(readContext7ReviewRecord(dir), value);
    const disk = readFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), "utf8");
    assert.doesNotMatch(disk, /transient raw documentation|export const/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two-claim proof with a recoverable query retry round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-two-claim-"));
  try {
    const value = twoClaimRecord();
    writeContext7ReviewRecord(dir, value);
    assert.deepEqual(readContext7ReviewRecord(dir), value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-claim proof rejects missing resolvers and cross-claim evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-claim-proof-"));
  try {
    const single = record();
    writeContext7ReviewRecord(dir, {
      ...single,
      outcome: {
        ...single.outcome,
        lifecycle: single.outcome.lifecycle.filter((row) => row.tool !== "mcp__context7__resolve-library-id"),
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "query proof without a successful same-claim resolver fails closed");

    const crossRouted = twoClaimRecord();
    writeContext7ReviewRecord(dir, {
      ...crossRouted,
      outcome: {
        ...crossRouted.outcome,
        lifecycle: crossRouted.outcome.lifecycle.filter(
          (row) => !(row.claimId === "EC-2" && row.tool === "mcp__context7__resolve-library-id"),
        ),
      },
    });
    assert.equal(
      readContext7ReviewRecord(dir),
      null,
      "an EC-1 resolver cannot authorize the EC-2 query and evidence chain",
    );

    const crossHash = twoClaimRecord();
    writeContext7ReviewRecord(dir, {
      ...crossHash,
      outcome: {
        ...crossHash.outcome,
        evidence: crossHash.outcome.evidence.map((row) => ({
          ...row,
          evidenceHash: row.claimId === "EC-1" ? "d".repeat(64) : "b".repeat(64),
        })),
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "query hashes cannot cross claim identities");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt or structurally incomplete record fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-bad-"));
  try {
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), "not json");
    assert.equal(readContext7ReviewRecord(dir), null);

    const malformed = record() as unknown as Record<string, unknown>;
    malformed["scope"] = { projectId: "coding-agent", claims: [null] };
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(malformed));
    assert.equal(readContext7ReviewRecord(dir), null);

    const emptyScope = record() as unknown as Record<string, unknown>;
    emptyScope["scope"] = { projectId: "coding-agent", claims: [] };
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(emptyScope));
    assert.equal(readContext7ReviewRecord(dir), null, "empty review scopes must fail closed");

    const contradictory = record() as unknown as Record<string, unknown>;
    contradictory["outcome"] = { ...(contradictory["outcome"] as Record<string, unknown>), verdict: null };
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(contradictory));
    assert.equal(readContext7ReviewRecord(dir), null, "completed without a verdict must never render as evidence complete");

    const evidenceMissing = record() as unknown as Record<string, unknown>;
    evidenceMissing["outcome"] = {
      ...(evidenceMissing["outcome"] as Record<string, unknown>),
      evidence: [],
    };
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(evidenceMissing));
    assert.equal(readContext7ReviewRecord(dir), null, "completed external review needs admitted evidence for every claim");

    const missingConnected = record() as unknown as Record<string, unknown>;
    const missingConnectedOutcome = missingConnected["outcome"] as Record<string, unknown>;
    missingConnectedOutcome["lifecycle"] = (missingConnectedOutcome["lifecycle"] as readonly Record<string, unknown>[])
      .filter((row) => row["state"] !== "connected");
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(missingConnected));
    assert.equal(readContext7ReviewRecord(dir), null, "completed evidence cannot skip SDK inventory connection");

    const unknownFinding = record() as unknown as Record<string, unknown>;
    const unknownOutcome = unknownFinding["outcome"] as Record<string, unknown>;
    const unknownVerdict = unknownOutcome["verdict"] as Record<string, unknown>;
    unknownOutcome["verdict"] = {
      ...unknownVerdict,
      findings: [{ claimId: "EC-404", severity: "error", title: "Unknown", detail: "Not in scope." }],
    };
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(unknownFinding));
    assert.equal(readContext7ReviewRecord(dir), null, "findings may not refer to claims outside the reviewed scope");

    const extraEvidence = record() as unknown as Record<string, unknown>;
    const extraOutcome = extraEvidence["outcome"] as Record<string, unknown>;
    extraOutcome["evidence"] = [
      ...(extraOutcome["evidence"] as readonly unknown[]),
      {
        package: "react",
        versionOrRange: "19.x",
        queryPurpose: "not in scope",
        success: true,
        evidenceHash: "f".repeat(64),
        seat: "independent_code_review",
      },
    ];
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(extraEvidence));
    assert.equal(readContext7ReviewRecord(dir), null, "unscoped evidence projections must fail closed");

    const wrongObligation = record() as unknown as Record<string, unknown>;
    const wrongOutcome = wrongObligation["outcome"] as Record<string, unknown>;
    wrongOutcome["lifecycle"] = (wrongOutcome["lifecycle"] as readonly Record<string, unknown>[]).map((row) => ({
      ...row,
      obligationHash: "f".repeat(64),
    }));
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(wrongObligation));
    assert.equal(readContext7ReviewRecord(dir), null, "lifecycle rows must bind the compiled host obligation");

    const resolverOnly = record() as unknown as Record<string, unknown>;
    const resolverOutcome = resolverOnly["outcome"] as Record<string, unknown>;
    resolverOutcome["lifecycle"] = (resolverOutcome["lifecycle"] as readonly Record<string, unknown>[]).map((row) =>
      row["state"] === "succeeded" ? { ...row, tool: "mcp__context7__resolve-library-id" } : row,
    );
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(resolverOnly));
    assert.equal(readContext7ReviewRecord(dir), null, "resolver output cannot bind query-docs evidence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a schema-valid record with no review claims fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-empty-scope-"));
  try {
    const emptyScope: Context7ReviewRecord = {
      ...record(),
      scope: { projectId: "coding-agent", claims: [] },
    };
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(emptyScope));
    assert.equal(readContext7ReviewRecord(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle success states reject error codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-lifecycle-code-"));
  try {
    for (const state of ["succeeded", "satisfied"] as const) {
      const invalid = record();
      const lifecycle = invalid.outcome.lifecycle.map((row) =>
        row.state === state ? { ...row, code: "tool_error" as const } : row,
      );
      writeContext7ReviewRecord(dir, { ...invalid, outcome: { ...invalid.outcome, lifecycle } });
      assert.equal(readContext7ReviewRecord(dir), null, `${state} lifecycle rows must not carry error codes`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle rows reject tool, code, and artifact contradictions", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-lifecycle-shape-"));
  try {
    const base = record();
    const obligationHash = base.outcome.lifecycle[0]?.obligationHash;
    assert.ok(obligationHash);
    const invalidRows = [
      {
        seat: "independent_code_review" as const,
        obligationHash,
        server: "context7",
        tool: "mcp__context7__query-docs",
        claimId: "EC-1",
        state: "denied" as const,
        code: "session_error" as const,
        producedArtefactHashes: [],
      },
      {
        seat: "independent_code_review" as const,
        obligationHash,
        server: "context7",
        tool: null,
        claimId: null,
        state: "attempted" as const,
        code: null,
        producedArtefactHashes: [],
      },
      {
        seat: "independent_code_review" as const,
        obligationHash,
        server: "context7",
        tool: "mcp__context7__query-docs",
        claimId: "EC-1",
        state: "succeeded" as const,
        code: null,
        producedArtefactHashes: [],
      },
      {
        seat: "independent_code_review" as const,
        obligationHash,
        server: "context7",
        tool: null,
        claimId: null,
        state: "failed" as const,
        code: "tool_error" as const,
        producedArtefactHashes: [],
      },
      {
        seat: "independent_code_review" as const,
        obligationHash,
        server: "context7",
        tool: null,
        claimId: null,
        state: "planned" as const,
        code: null,
        producedArtefactHashes: ["b".repeat(64)],
      },
      {
        seat: "independent_code_review" as const,
        obligationHash,
        server: "context7",
        tool: null,
        claimId: null,
        state: "unsatisfied" as const,
        code: "source_incomplete" as const,
        producedArtefactHashes: [],
      },
    ];

    for (const row of invalidRows) {
      writeContext7ReviewRecord(dir, {
        ...base,
        outcome: {
          ...base.outcome,
          lifecycle: [...base.outcome.lifecycle.slice(0, -1), row, ...base.outcome.lifecycle.slice(-1)],
        },
      });
      assert.equal(readContext7ReviewRecord(dir), null, `${row.state}/${String(row.code)} must fail closed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production lifecycle shapes remain readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-lifecycle-valid-"));
  try {
    const base = record();
    const obligationHash = base.outcome.lifecycle[0]?.obligationHash;
    assert.ok(obligationHash);
    const valid: Context7ReviewRecord = {
      ...base,
      outcome: {
        ...base.outcome,
        lifecycle: [
          ...base.outcome.lifecycle.slice(0, 5),
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__resolve-library-id",
            claimId: "EC-1",
            state: "attempted",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__resolve-library-id",
            claimId: "EC-1",
            state: "succeeded",
            code: null,
            producedArtefactHashes: ["c".repeat(64)],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__query-docs",
            claimId: "EC-1",
            state: "attempted",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__query-docs",
            claimId: "EC-1",
            state: "failed",
            code: "tool_error",
            producedArtefactHashes: [],
          },
          ...base.outcome.lifecycle.slice(5),
        ],
      },
    };

    writeContext7ReviewRecord(dir, valid);
    assert.deepEqual(readContext7ReviewRecord(dir), valid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcome status accepts only its production code family", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-outcome-code-"));
  try {
    const base = record();
    const outcome = { ...base.outcome, verdict: null, evidence: [], lifecycle: [] };

    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: { ...outcome, status: "failed", code: "source_incomplete" },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "failed outcomes may not use an unsatisfied preflight code");

    const validUnsatisfied: Context7ReviewRecord = {
      ...base,
      source: { ...base.source, truncated: true },
      outcome: { ...outcome, status: "unsatisfied", code: "source_incomplete" },
    };
    writeContext7ReviewRecord(dir, validUnsatisfied);
    assert.deepEqual(readContext7ReviewRecord(dir), validUnsatisfied);

    const validFailed: Context7ReviewRecord = {
      ...base,
      outcome: {
        ...outcome,
        status: "failed",
        code: "session_error",
        lifecycle: [
          ...base.outcome.lifecycle.slice(0, 2),
          {
            seat: "independent_code_review",
            obligationHash: base.outcome.lifecycle[0]?.obligationHash ?? "",
            server: "context7",
            tool: null,
            claimId: null,
            state: "failed",
            code: "session_error",
            producedArtefactHashes: [],
          },
        ],
      },
    };
    writeContext7ReviewRecord(dir, validFailed);
    assert.deepEqual(readContext7ReviewRecord(dir), validFailed);

    const obligationHash = base.outcome.lifecycle[0]?.obligationHash;
    assert.ok(obligationHash);
    const validBootstrapFailure: Context7ReviewRecord = {
      ...base,
      outcome: {
        ...outcome,
        status: "failed",
        code: "bootstrap_protocol_error",
        lifecycle: [
          ...base.outcome.lifecycle.slice(0, 2),
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "unsatisfied",
            code: "bootstrap_protocol_error",
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "failed",
            code: "bootstrap_protocol_error",
            producedArtefactHashes: [],
          },
        ],
      },
    };
    writeContext7ReviewRecord(dir, validBootstrapFailure);
    assert.deepEqual(readContext7ReviewRecord(dir), validBootstrapFailure);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source snapshot completeness is bound to its production preflight outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-source-state-"));
  try {
    const base = record();
    const preflight = {
      ...base.outcome,
      status: "unsatisfied" as const,
      verdict: null,
      evidence: [],
      lifecycle: [],
    };

    const sourceIncomplete: Context7ReviewRecord = {
      ...base,
      source: { ...base.source, truncated: true },
      outcome: { ...preflight, code: "source_incomplete" },
    };
    writeContext7ReviewRecord(dir, sourceIncomplete);
    assert.deepEqual(readContext7ReviewRecord(dir), sourceIncomplete);

    const sourceUnavailable: Context7ReviewRecord = {
      ...base,
      source: { ...base.source, files: [], truncated: false },
      outcome: { ...preflight, code: "source_unavailable" },
    };
    writeContext7ReviewRecord(dir, sourceUnavailable);
    assert.deepEqual(readContext7ReviewRecord(dir), sourceUnavailable);

    const unavailableWorkspace: Context7ReviewRecord = {
      ...base,
      source: { ...base.source, files: [], truncated: true },
      outcome: { ...preflight, code: "scope_unavailable" },
    };
    writeContext7ReviewRecord(dir, unavailableWorkspace);
    assert.deepEqual(
      readContext7ReviewRecord(dir),
      unavailableWorkspace,
      "scope failure takes precedence when the missing workspace also has no source",
    );

    for (const [label, value] of [
      ["completed review over truncated source", { ...base, source: { ...base.source, truncated: true } }],
      ["completed review without source files", { ...base, source: { ...base.source, files: [] } }],
      [
        "source_incomplete with a complete snapshot",
        { ...base, outcome: { ...preflight, code: "source_incomplete" } },
      ],
      [
        "source_unavailable with captured files",
        { ...base, outcome: { ...preflight, code: "source_unavailable" } },
      ],
    ] as const) {
      writeContext7ReviewRecord(dir, value);
      assert.equal(readContext7ReviewRecord(dir), null, label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero-obligation internal failures and invalid output remain durable", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-internal-outcomes-"));
  try {
    const base = record();
    const internalScope: Context7ReviewRecord["scope"] = {
      projectId: "coding-agent",
      claims: [{ kind: "internal", id: "IC-1", subject: "Repository-internal behavior." }],
    };
    const failed: Context7ReviewRecord = {
      ...base,
      scope: internalScope,
      outcome: {
        status: "failed",
        capabilityApplicability: "not_applicable",
        code: "session_error",
        verdict: null,
        evidence: [],
        lifecycle: [],
      },
    };
    writeContext7ReviewRecord(dir, failed);
    assert.deepEqual(readContext7ReviewRecord(dir), failed);

    const unsatisfied: Context7ReviewRecord = {
      ...failed,
      outcome: {
        ...failed.outcome,
        status: "unsatisfied",
        code: "invalid_structured_output",
      },
    };
    writeContext7ReviewRecord(dir, unsatisfied);
    assert.deepEqual(readContext7ReviewRecord(dir), unsatisfied);

    writeContext7ReviewRecord(dir, {
      ...unsatisfied,
      outcome: { ...unsatisfied.outcome, code: "required_evidence_missing" },
    });
    assert.equal(
      readContext7ReviewRecord(dir),
      null,
      "an internal-only review cannot report a missing external evidence obligation",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable applicability exactly matches the production scope compiler", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-applicability-"));
  try {
    const base = record();
    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: { ...base.outcome, capabilityApplicability: "suggested" },
    });
    assert.equal(
      readContext7ReviewRecord(dir),
      null,
      "an external production claim cannot relabel mandatory Context7 as suggested",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcome history rejects contradictory terminal and evidence sequences", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-outcome-history-"));
  try {
    const base = record();
    const obligationHash = base.outcome.lifecycle[0]?.obligationHash;
    const satisfied = base.outcome.lifecycle.at(-1);
    assert.ok(obligationHash);
    assert.ok(satisfied);

    const terminalFailure = {
      seat: "independent_code_review" as const,
      obligationHash,
      server: "context7",
      tool: null,
      claimId: null,
      state: "failed" as const,
      code: "session_error" as const,
      producedArtefactHashes: [],
    };
    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: {
        ...base.outcome,
        lifecycle: [...base.outcome.lifecycle.slice(0, -1), terminalFailure, satisfied],
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "a completed record cannot continue after session failure");

    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: {
        ...base.outcome,
        lifecycle: [
          ...base.outcome.lifecycle.slice(0, 3),
          satisfied,
          ...base.outcome.lifecycle.slice(3, -1),
        ],
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "satisfaction cannot precede the positive tool chain");

    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: {
        ...base.outcome,
        lifecycle: [
          ...base.outcome.lifecycle.slice(0, -1),
          {
            ...satisfied,
            state: "unsatisfied",
            code: null,
          },
        ],
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "completed external records must end with satisfied");

    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: {
        ...base.outcome,
        lifecycle: [
          ...base.outcome.lifecycle.slice(0, -1),
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__resolve-library-id",
            claimId: "EC-1",
            state: "attempted",
            code: null,
            producedArtefactHashes: [],
          },
          satisfied,
        ],
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "terminal satisfaction cannot leave an unmatched tool attempt open");

    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: {
        ...base.outcome,
        status: "unsatisfied",
        code: "source_incomplete",
        verdict: null,
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "preflight outcomes cannot retain query evidence");

    const unavailableTerminal = {
      seat: "independent_code_review" as const,
      obligationHash,
      server: "context7",
      tool: null,
      claimId: null,
      state: "unsatisfied" as const,
      code: "tool_unavailable" as const,
      producedArtefactHashes: [],
    };
    writeContext7ReviewRecord(dir, {
      ...base,
      outcome: {
        ...base.outcome,
        status: "capability_unavailable",
        code: "tool_unavailable",
        verdict: null,
        lifecycle: [...base.outcome.lifecycle.slice(0, -1), unavailableTerminal],
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "capability-unavailable outcomes cannot retain query evidence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capability-unavailable history with a matching terminal row remains readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-capability-unavailable-"));
  try {
    const base = record();
    const obligationHash = base.outcome.lifecycle[0]?.obligationHash;
    assert.ok(obligationHash);
    const unavailable: Context7ReviewRecord = {
      ...base,
      outcome: {
        status: "capability_unavailable",
        capabilityApplicability: "required",
        code: "pilot_not_enabled",
        verdict: null,
        evidence: [],
        lifecycle: [
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "planned",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "unsatisfied",
            code: "pilot_not_enabled",
            producedArtefactHashes: [],
          },
        ],
      },
    };

    writeContext7ReviewRecord(dir, unavailable);
    assert.deepEqual(readContext7ReviewRecord(dir), unavailable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-completed records may keep only a scoped unique evidence subset", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-unsatisfied-"));
  try {
    const unsatisfied: Context7ReviewRecord = {
      ...record(),
      scope: {
        projectId: "coding-agent",
        claims: [
          {
            kind: "external",
            id: "EC-1",
            package: "next",
            versionOrRange: "16.x",
            queryPurpose: "Verify current Next.js usage.",
          },
          {
            kind: "external",
            id: "EC-2",
            package: "react",
            versionOrRange: "19.x",
            queryPurpose: "Verify current React usage.",
          },
        ],
      },
      outcome: {
        status: "unsatisfied",
        capabilityApplicability: "required",
        code: "required_evidence_missing",
        verdict: null,
        evidence: [
          {
            claimId: "EC-1",
            package: "next",
            versionOrRange: "16.x",
            queryPurpose: "Verify current Next.js usage.",
            success: true,
            evidenceHash: "b".repeat(64),
            seat: "independent_code_review",
          },
        ],
        lifecycle: [],
      },
    };
    const obligationHash = expectedContext7ObligationHashes(unsatisfied.scope)[0];
    assert.ok(obligationHash);

    writeContext7ReviewRecord(dir, unsatisfied);
    assert.equal(
      readContext7ReviewRecord(dir),
      null,
      "partial evidence still needs a successful query-docs lifecycle row",
    );

    const unsatisfiedWithQuery: Context7ReviewRecord = {
      ...unsatisfied,
      outcome: {
        ...unsatisfied.outcome,
        lifecycle: [
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "planned",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "granted",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "connected",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__resolve-library-id",
            claimId: "EC-1",
            state: "attempted",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__resolve-library-id",
            claimId: "EC-1",
            state: "succeeded",
            code: null,
            producedArtefactHashes: ["c".repeat(64)],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__query-docs",
            claimId: "EC-1",
            state: "attempted",
            code: null,
            producedArtefactHashes: [],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: "mcp__context7__query-docs",
            claimId: "EC-1",
            state: "succeeded",
            code: null,
            producedArtefactHashes: ["b".repeat(64)],
          },
          {
            seat: "independent_code_review",
            obligationHash,
            server: "context7",
            tool: null,
            claimId: null,
            state: "unsatisfied",
            code: "required_evidence_missing",
            producedArtefactHashes: [],
          },
        ],
      },
    };

    writeContext7ReviewRecord(dir, unsatisfiedWithQuery);
    assert.deepEqual(
      readContext7ReviewRecord(dir)?.outcome.evidence.map((row) => row.package),
      ["next"],
      "a non-completed record may retain admitted evidence for claims it did route",
    );

    writeContext7ReviewRecord(dir, {
      ...unsatisfiedWithQuery,
      outcome: {
        ...unsatisfiedWithQuery.outcome,
        evidence: [
          ...unsatisfiedWithQuery.outcome.evidence,
          {
            claimId: "EC-1",
            package: "next",
            versionOrRange: "16.x",
            queryPurpose: "Verify current Next.js usage.",
            success: true,
            evidenceHash: "d".repeat(64),
            seat: "independent_code_review",
          },
        ],
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "duplicate claim evidence fails closed even before completion");

    writeContext7ReviewRecord(dir, {
      ...unsatisfiedWithQuery,
      outcome: {
        ...unsatisfiedWithQuery.outcome,
        evidence: [
          {
            claimId: "EC-404",
            package: "lucide-react",
            versionOrRange: "0.468.0",
            queryPurpose: "Verify current lucide usage.",
            success: true,
            evidenceHash: "e".repeat(64),
            seat: "independent_code_review",
          },
        ],
      },
    });
    assert.equal(readContext7ReviewRecord(dir), null, "unscoped evidence fails closed even before completion");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader reconstructs known fields so raw source and arbitrary extras cannot cross the API", () => {
  const dir = mkdtempSync(join(tmpdir(), "context7-record-project-"));
  try {
    const raw = record() as unknown as Record<string, unknown>;
    raw["unknown"] = "do not return";
    raw["scope"] = { ...(raw["scope"] as Record<string, unknown>), scopeFailure: null };
    raw["source"] = { ...(raw["source"] as Record<string, unknown>), text: "raw source must not cross" };
    writeFileSync(join(dir, CONTEXT7_REVIEW_RECORD_FILE), JSON.stringify(raw));
    const projected = readContext7ReviewRecord(dir);
    assert.ok(projected);
    assert.equal("unknown" in projected, false);
    assert.equal("scopeFailure" in projected.scope, false);
    assert.equal("text" in projected.source, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
