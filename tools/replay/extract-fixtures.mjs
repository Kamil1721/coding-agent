#!/usr/bin/env node
/**
 * EXTRACT THE a913c871 AUTHORING FIXTURES OUT OF THE CLI SESSION TRANSCRIPTS.
 *
 * WHY THIS EXISTS AND WHY IT IS URGENT. The three authoring attempts of
 * `run-2026-08-09T21-04-00-713Z-a913c871` left NO harness artefact — see
 * `docs/RUN-a913c871-observations.md` §TIMELINE, CONTINUED: "The three authoring
 * attempts left no harness artefact. They were recovered after the fact from the
 * Claude Code CLI's own session transcripts". `authoringTrail` reaches disk only
 * via `freezeSuite`, which is only called on SUCCESS, so a failing run persists
 * nothing. The same post-mortem records the risk plainly: "A different cwd, or
 * transcript retention off, and attempts 1-3 would be unrecoverable."
 *
 * This script moves that data from a reapable session directory into the repo.
 * After it has run once, the fixtures are the record; this script is only needed
 * again to extend the corpus with a NEW run's transcripts.
 *
 * WHAT IT DOES NOT COPY, DELIBERATELY. The attempt prompts carry the owner's real
 * CV as a base64 PDF and a 560 KB reference PNG. Neither is written here. The
 * prompt TEXT block is written (it is the ticket brief the harness itself
 * composed) and the attachments are recorded as {mediaType, bytes, sha256} only.
 *
 * USAGE
 *   node tools/replay/extract-fixtures.mjs [--out <dir>] [--check]
 *
 *   --check   re-extract into memory and diff against the fixtures on disk;
 *             exit non-zero if they differ. Does not write. This is what proves
 *             the committed fixtures were not hand-edited, for as long as the
 *             transcripts survive.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(HERE, "fixtures");

/**
 * The three sessions, in attempt order, as identified in
 * `docs/RUN-a913c871-observations.md` §TIMELINE, CONTINUED.
 */
export const A913C871_SESSIONS = Object.freeze([
  Object.freeze({ attempt: 1, sessionPrefix: "cfdffda9", spanFromPostMortem: "21:06:30 → 21:31:52" }),
  Object.freeze({ attempt: 2, sessionPrefix: "60fcb909", spanFromPostMortem: "21:31:54 → 22:07:19" }),
  Object.freeze({ attempt: 3, sessionPrefix: "e327a0fb", spanFromPostMortem: "22:07:20 → 22:31:03" }),
]);

export const TRANSCRIPT_DIR = path.join(
  homedir(),
  ".claude",
  "projects",
  "-Users-kamilborzecki-Projects-coding-agent-dashboard",
);

export const RUN_ID = "run-2026-08-09T21-04-00-713Z-a913c871";
export const TICKET_ID = "t-b79ff5e2a1b314e4";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable serialisation: key order is not evidence, values are. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function resolveSession(prefix) {
  if (!existsSync(TRANSCRIPT_DIR)) return null;
  const hit = readdirSync(TRANSCRIPT_DIR).find((f) => f.startsWith(prefix) && f.endsWith(".jsonl"));
  return hit === undefined ? null : path.join(TRANSCRIPT_DIR, hit);
}

/**
 * Pull one attempt out of one transcript: the manifest the seat emitted, the
 * prompt text it was shown, and the attachment digests.
 */
export function extractAttempt(transcriptPath) {
  const lines = readFileSync(transcriptPath, "utf8").split("\n");
  let manifestSource = null;
  let manifestAt = null;
  let promptText = null;
  let promptAt = null;
  let testFilePaths = null;
  let criteriaCount = null;
  const attachments = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;

    if (record.type === "user" && promptText === null) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          promptText = block.text;
          promptAt = record.timestamp ?? null;
        } else if (block?.type === "document" || block?.type === "image") {
          const data = block?.source?.data;
          if (typeof data === "string") {
            attachments.push({
              kind: block.type,
              mediaType: block?.source?.media_type ?? null,
              base64Chars: data.length,
              sha256OfBase64: sha256(data),
            });
          }
        }
      }
    }

    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const input = block.input;
      if (!input || typeof input !== "object") continue;
      const files = input.testFiles;
      if (!Array.isArray(files)) continue;
      const manifestFile = files.find((f) => f?.path === "suite.manifest.json");
      if (manifestFile === undefined || typeof manifestFile.source !== "string") continue;
      manifestSource = manifestFile.source;
      manifestAt = record.timestamp ?? null;
      testFilePaths = files.map((f) => f?.path);
      criteriaCount = Array.isArray(input.criteria) ? input.criteria.length : null;
    }
  }

  return { manifestSource, manifestAt, promptText, promptAt, testFilePaths, criteriaCount, attachments };
}

export function buildFixtures() {
  const fixtures = [];
  for (const session of A913C871_SESSIONS) {
    const transcriptPath = resolveSession(session.sessionPrefix);
    if (transcriptPath === null) {
      throw new Error(
        `transcript for attempt ${session.attempt} (session ${session.sessionPrefix}…) not found under ${TRANSCRIPT_DIR}. ` +
          `The session directory is reapable; if it is gone the committed fixtures under ${FIXTURE_DIR} are now the only copy.`,
      );
    }
    const got = extractAttempt(transcriptPath);
    if (got.manifestSource === null) {
      throw new Error(`no suite.manifest.json tool_use found in ${transcriptPath}`);
    }
    const manifest = JSON.parse(got.manifestSource);
    fixtures.push({
      id: `a913c871-attempt${session.attempt}`,
      runId: RUN_ID,
      ticketId: TICKET_ID,
      attempt: session.attempt,
      provenance: {
        source: "claude-code CLI session transcript (NOT a harness artefact)",
        transcript: path.basename(transcriptPath),
        emittedAt: got.manifestAt,
        promptAt: got.promptAt,
        spanFromPostMortem: session.spanFromPostMortem,
        citedIn: "docs/RUN-a913c871-observations.md §TIMELINE, CONTINUED",
      },
      promptTextSha256: got.promptText === null ? null : sha256(got.promptText),
      promptTextChars: got.promptText === null ? null : got.promptText.length,
      attachments: got.attachments,
      testFilePaths: got.testFilePaths,
      criteriaCount: got.criteriaCount,
      manifestSha256: sha256(got.manifestSource),
      /**
       * Hash of the manifest in CANONICAL form (keys sorted, no whitespace).
       * `manifestSha256` above hashes the seat's original source string, which
       * the pretty-printed fixture file does not reproduce byte for byte. This
       * one does, so ARM 3 can compare a real recorded value against the file on
       * disk instead of hashing the same bytes twice and always agreeing.
       */
      manifestCanonicalSha256: sha256(canonicalJson(manifest)),
      manifest,
      promptText: got.promptText,
    });
  }
  return fixtures;
}

function fixtureFiles(fixtures) {
  /** Two files per attempt: the manifest verbatim, and everything about it. */
  const out = new Map();
  for (const f of fixtures) {
    const { manifest, promptText, ...meta } = f;
    out.set(`${f.id}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    out.set(`${f.id}.prompt.txt`, promptText === null ? "" : promptText);
    out.set(`${f.id}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  }
  return out;
}

function main(argv) {
  const check = argv.includes("--check");
  const outAt = argv.indexOf("--out");
  const outDir = outAt >= 0 ? argv[outAt + 1] : FIXTURE_DIR;

  const fixtures = buildFixtures();
  const files = fixtureFiles(fixtures);

  if (check) {
    let bad = 0;
    for (const [name, body] of files) {
      const onDisk = path.join(outDir, name);
      if (!existsSync(onDisk)) {
        console.error(`MISSING  ${name}`);
        bad += 1;
        continue;
      }
      const have = readFileSync(onDisk, "utf8");
      if (have !== body) {
        console.error(`DIFFERS  ${name}  (disk sha ${sha256(have).slice(0, 12)} vs transcript ${sha256(body).slice(0, 12)})`);
        bad += 1;
      } else {
        console.log(`ok       ${name}  ${sha256(body).slice(0, 12)}`);
      }
    }
    if (bad > 0) {
      console.error(`\n${bad} fixture(s) do not match the transcripts they claim to come from.`);
      process.exit(1);
    }
    console.log(`\nall ${files.size} fixture file(s) match the CLI transcripts byte for byte.`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  for (const [name, body] of files) {
    writeFileSync(path.join(outDir, name), body);
    console.log(`wrote ${path.join(outDir, name)}  ${body.length} B  ${sha256(body).slice(0, 12)}`);
  }
  console.log(`\n${fixtures.length} attempt(s) extracted from ${TRANSCRIPT_DIR}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
